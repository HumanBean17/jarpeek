/**
 * Gradle resolver — the primary source of dependency truth.
 *
 * `resolveGradle` asks the project's own build where its dependencies
 * resolved to: it injects a Groovy init script (`gradle-init.ts`) and runs
 * `gradlew -I ... --console=plain -q --no-configuration-cache jarpeekDump`,
 * which prints one JSON document between sentinel lines. Everything here
 * degrades rather than fails: a missing wrapper plus no Gradle on PATH, a
 * timeout, a failed build, silent output, or malformed JSON each become
 * `{ ok: false, reason }` so the resolver facade can fall back to the cache
 * scan.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";
import { moduleCoordinates } from "./module-coordinate.js";
import { ensureGradleInitScript } from "./gradle-init.js";
import { runWithTimeout, SpawnError, TimeoutError, type RunResult } from "../util/exec.js";

export const BEGIN_SENTINEL = "###JARPEEK-BEGIN###";
export const END_SENTINEL = "###JARPEEK-END###";

const DEFAULT_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 500;

export interface GradleResolution {
  ok: boolean;
  artifacts: DependencyArtifact[];
  reason?: "no-wrapper-no-gradle" | "timeout" | `gradle-failed:${string}` | "no-output" | "bad-json";
}

export interface ResolveGradleOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real spawner. */
  exec?: typeof runWithTimeout;
  /** Explicit gradle/wrapper command override; skips platform detection. */
  wrapper?: string;
  /** Injectable PATH probe consulted before the bare-gradle fallback. */
  gradleOnPath?: () => boolean;
}

/** One dependency entry as printed by the init script. */
interface DumpDependency {
  coordinates: string;
  kind: "external" | "module";
  path: string;
}

/** One configuration entry; a failed resolution carries `error` instead. */
interface DumpConfiguration {
  name: string;
  dependencies?: DumpDependency[];
  error?: string;
}

interface DumpDocument {
  configurations?: DumpConfiguration[];
  sources?: Record<string, string>;
}

/**
 * Configuration name → artifact label. kapt* (Kotlin annotation processing)
 * maps to annotationProcessor ahead of the substring checks; test-ness beats
 * compile/runtime because a test classpath is a test classpath. Mirrors
 * `configLabel` in the Groovy init script — keep the two in sync.
 */
export function configurationLabel(
  name: string,
): "compile" | "runtime" | "test" | "annotationProcessor" {
  if (name.startsWith("kapt") || name.includes("annotationProcessor")) return "annotationProcessor";
  if (name.includes("test")) return "test";
  if (name.includes("compile")) return "compile";
  if (name.includes("runtime")) return "runtime";
  return "compile";
}

/** Text between the sentinels, or null when either sentinel is absent. */
function extractBetweenSentinels(stdout: string): string | null {
  const begin = stdout.indexOf(BEGIN_SENTINEL);
  if (begin === -1) return null;
  const end = stdout.indexOf(END_SENTINEL, begin + BEGIN_SENTINEL.length);
  if (end === -1) return null;
  return stdout.slice(begin + BEGIN_SENTINEL.length, end);
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : trimmed.slice(-STDERR_TAIL_CHARS);
}

/**
 * Diagnosis text for a failed gradle run, never empty: the stderr tail, else
 * the stdout tail (a quiet `-q` run may print its only error there), else a
 * marker naming the exit code — a signal kill says `(killed)` since it has
 * none. Mirrors `failureDetail` in the Maven resolver.
 */
function failureDetail(result: RunResult): string {
  const tail = stderrTail(result.stderr);
  if (tail.length > 0) return tail;
  const out = stderrTail(result.stdout);
  if (out.length > 0) return out;
  return result.code === null ? "(killed)" : `exit ${result.code} (no output)`;
}

/**
 * Dump document → artifacts, deduplicated by coordinates with the first
 * configuration in document order winning (compileClasspath precedes
 * runtimeClasspath in the init script's iteration, so main-compile labels
 * stick). External artifacts pair with the sources map; module artifacts
 * carry the project directory under namespaced coordinates — the bare
 * project path (":app") would collide with another project's identically
 * named module in the user-global index cache. Errored configurations
 * contribute nothing.
 */
function mapArtifacts(document: DumpDocument, projectRoot: string): DependencyArtifact[] {
  const byCoordinates = new Map<string, DependencyArtifact>();
  const sources = document.sources ?? {};

  for (const configuration of document.configurations ?? []) {
    for (const dependency of configuration.dependencies ?? []) {
      if (dependency.kind === "module") {
        const coordinates = moduleCoordinates(projectRoot, dependency.coordinates);
        if (byCoordinates.has(coordinates)) continue;
        byCoordinates.set(coordinates, {
          coordinates,
          kind: "module",
          sourceDir: dependency.path,
          provenance: "source",
          warnings: [],
        });
        continue;
      }
      if (byCoordinates.has(dependency.coordinates)) continue;
      const sourcesJar = sources[dependency.coordinates];
      byCoordinates.set(dependency.coordinates, {
        coordinates: dependency.coordinates,
        configuration: configurationLabel(configuration.name),
        kind: "external",
        binaryJar: dependency.path,
        ...(sourcesJar !== undefined ? { sourcesJar } : {}),
        provenance: sourcesJar !== undefined ? "source" : "signature",
        warnings: [],
      });
    }
  }
  return [...byCoordinates.values()];
}

interface SelectedCommand {
  command: string;
  /** Platform plumbing that precedes the gradle args (e.g. `/c gradlew.bat`). */
  preArgs: string[];
  /** True when neither wrapper exists and bare `gradle` is the command. */
  bare: boolean;
}

/**
 * Wrapper selection: the platform wrapper when present (`cmd /c gradlew.bat`
 * on win32 — .bat files cannot be spawned directly), bare `gradle`
 * otherwise. On win32 the bare fallback also goes through `cmd` so a
 * gradle.bat on PATH is reachable; its absence is caught by the PATH probe
 * in `resolveGradle` before anything is spawned.
 */
function selectCommand(projectRoot: string): SelectedCommand {
  if (process.platform === "win32") {
    const bat = join(projectRoot, "gradlew.bat");
    if (existsSync(bat)) return { command: "cmd", preArgs: ["/c", bat], bare: false };
    return { command: "cmd", preArgs: ["/c", "gradle"], bare: true };
  }
  const sh = join(projectRoot, "gradlew");
  if (existsSync(sh)) return { command: sh, preArgs: [], bare: false };
  return { command: "gradle", preArgs: [], bare: true };
}

/**
 * PATH probe for a system Gradle, consulted only when no wrapper exists:
 * on win32 any PATHEXT match (gradle.bat/.cmd/.exe) counts, elsewhere the
 * `gradle` binary must exist and be executable somewhere on PATH.
 */
export function gradleOnPathDefault(): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  if (process.platform === "win32") {
    const exts = (process.env.PATHEXT ?? ".com;.exe;.bat;.cmd")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0);
    return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, `gradle${ext}`))));
  }
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, "gradle"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve a Gradle project's dependencies via the injected init script.
 * Every recognized failure mode — no wrapper and no Gradle on PATH, timeout,
 * spawn failure, non-zero exit, missing sentinels, malformed JSON — becomes
 * a `{ ok: false, reason }` resolution; an unexpected error thrown by `exec`
 * itself (neither `TimeoutError` nor `SpawnError`) propagates to the caller.
 */
export async function resolveGradle(
  projectRoot: string,
  opts: ResolveGradleOptions = {},
): Promise<GradleResolution> {
  const exec = opts.exec ?? runWithTimeout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initScriptPath = await ensureGradleInitScript(projectRoot);

  const selected: SelectedCommand =
    opts.wrapper !== undefined ? { command: opts.wrapper, preArgs: [], bare: false } : selectCommand(projectRoot);
  if (selected.bare && !(opts.gradleOnPath ?? gradleOnPathDefault)()) {
    return { ok: false, artifacts: [], reason: "no-wrapper-no-gradle" };
  }
  const args = [
    ...selected.preArgs,
    "-I",
    initScriptPath,
    "--console=plain",
    "-q",
    "--no-configuration-cache",
    "jarpeekDump",
  ];

  let result: RunResult;
  try {
    result = await exec(selected.command, args, { timeoutMs, cwd: projectRoot });
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { ok: false, artifacts: [], reason: "timeout" };
    }
    if (error instanceof SpawnError) {
      // bare gradle that cannot spawn despite a passing probe = treat as
      // absence; an existing wrapper that fails to exec is a build failure
      if (selected.bare) {
        return { ok: false, artifacts: [], reason: "no-wrapper-no-gradle" };
      }
      return { ok: false, artifacts: [], reason: `gradle-failed:${error.message}` };
    }
    throw error;
  }

  if (result.code !== 0) {
    return { ok: false, artifacts: [], reason: `gradle-failed:${failureDetail(result)}` };
  }

  const payload = extractBetweenSentinels(result.stdout);
  if (payload === null) {
    return { ok: false, artifacts: [], reason: "no-output" };
  }

  let document: DumpDocument;
  try {
    document = JSON.parse(payload) as DumpDocument;
  } catch {
    return { ok: false, artifacts: [], reason: "bad-json" };
  }
  return { ok: true, artifacts: mapArtifacts(document, projectRoot) };
}
