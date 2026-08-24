/**
 * Gradle resolver — the primary source of dependency truth.
 *
 * `resolveGradle` asks the project's own build where its dependencies
 * resolved to: it injects a Groovy init script (`gradle-init.ts`) and runs
 * the selected command with `-I ... --console=plain -q
 * --no-configuration-cache jarpeekDump`, which prints one JSON document
 * between sentinel lines. Which command runs is the build-tool strategy
 * (see `strategy.ts`): the system gradle from PATH first when its probe
 * passes, the root wrapper as fallback — and a failed first attempt (any
 * cause) advances to the next candidate. Everything here degrades rather
 * than fails: no command at all, a timeout, a failed build, silent output,
 * or malformed JSON each become `{ ok: false, reason }` so the resolver
 * facade can fall back to the cache scan.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";
import { moduleCoordinates } from "./module-coordinate.js";
import { ensureGradleInitScript } from "./gradle-init.js";
import type { BuildToolStrategy } from "./strategy.js";
import { runWithTimeout, SpawnError, TimeoutError, type RunResult } from "../util/exec.js";

export const BEGIN_SENTINEL = "###JARPEEK-BEGIN###";
export const END_SENTINEL = "###JARPEEK-END###";

const DEFAULT_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 500;

export interface GradleResolution {
  ok: boolean;
  artifacts: DependencyArtifact[];
  reason?:
    | "no-wrapper-no-gradle"
    | "no-wrapper"
    | "timeout"
    | `gradle-failed:${string}`
    | "no-output"
    | "bad-json";
}

export interface ResolveGradleOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real spawner. */
  exec?: typeof runWithTimeout;
  /** Explicit gradle/wrapper command override; skips platform detection and strategy. */
  wrapper?: string;
  /** Injectable PATH probe consulted before the bare-gradle fallback. */
  gradleOnPath?: () => boolean;
  /** Which gradle runs resolves; undefined means `auto` (system first, wrapper fallback). */
  strategy?: BuildToolStrategy;
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
      });
    }
  }
  return [...byCoordinates.values()];
}

/** One gradle command the resolver may run, tagged with where it came from. */
interface Candidate {
  via: "system" | "wrapper";
  command: string;
  /** Platform plumbing that precedes the gradle args (e.g. `/c gradlew.bat`). */
  preArgs: string[];
}

/** The root wrapper when present: `gradlew.bat` through `cmd /c` on win32 (.bat files cannot be spawned directly), `gradlew` elsewhere. */
function wrapperCandidate(projectRoot: string): Candidate | null {
  if (process.platform === "win32") {
    const bat = join(projectRoot, "gradlew.bat");
    return existsSync(bat) ? { via: "wrapper", command: "cmd", preArgs: ["/c", bat] } : null;
  }
  const sh = join(projectRoot, "gradlew");
  return existsSync(sh) ? { via: "wrapper", command: sh, preArgs: [] } : null;
}

/** The system gradle: on win32 through `cmd` so a gradle.bat on PATH is reachable; its absence is caught by the PATH probe before anything is spawned. */
function systemCandidate(): Candidate {
  return process.platform === "win32"
    ? { via: "system", command: "cmd", preArgs: ["/c", "gradle"] }
    : { via: "system", command: "gradle", preArgs: [] };
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

/** One candidate's failure: its solo reason, plus the bare detail for the combined form. */
interface AttemptFailure {
  via: "system" | "wrapper";
  /** Exactly what this attempt would have returned had it run alone. */
  solo: Exclude<GradleResolution["reason"], undefined>;
  /** The same failure without the `gradle-failed:` prefix, for the combined reason. */
  detail: string;
}

/**
 * Resolve a Gradle project's dependencies via the injected init script.
 * Candidates run in strategy order (an explicit `opts.wrapper` is the single
 * candidate and bypasses the strategy); the first `ok` wins, any failure
 * advances to the next candidate, and when every candidate failed the
 * reason names each attempt. Every recognized failure mode — no command at
 * all, timeout, spawn failure, non-zero exit, missing sentinels, malformed
 * JSON — becomes a `{ ok: false, reason }` resolution; an unexpected error
 * thrown by `exec` itself (neither `TimeoutError` nor `SpawnError`)
 * propagates to the caller.
 */
export async function resolveGradle(
  projectRoot: string,
  opts: ResolveGradleOptions = {},
): Promise<GradleResolution> {
  const exec = opts.exec ?? runWithTimeout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const strategy = opts.strategy ?? "auto";
  const initScriptPath = await ensureGradleInitScript(projectRoot);

  let candidates: Candidate[];
  if (opts.wrapper !== undefined) {
    candidates = [{ via: "wrapper", command: opts.wrapper, preArgs: [] }];
  } else if (strategy === "wrapper") {
    const wrapper = wrapperCandidate(projectRoot);
    if (wrapper === null) return { ok: false, artifacts: [], reason: "no-wrapper" };
    candidates = [wrapper];
  } else if (strategy === "system") {
    if (!(opts.gradleOnPath ?? gradleOnPathDefault)()) {
      return { ok: false, artifacts: [], reason: "no-wrapper-no-gradle" };
    }
    candidates = [systemCandidate()];
  } else {
    candidates = [];
    if ((opts.gradleOnPath ?? gradleOnPathDefault)()) candidates.push(systemCandidate());
    const wrapper = wrapperCandidate(projectRoot);
    if (wrapper !== null) candidates.push(wrapper);
    if (candidates.length === 0) {
      return { ok: false, artifacts: [], reason: "no-wrapper-no-gradle" };
    }
  }

  const failures: AttemptFailure[] = [];
  for (const candidate of candidates) {
    const args = [
      ...candidate.preArgs,
      "-I",
      initScriptPath,
      "--console=plain",
      "-q",
      "--no-configuration-cache",
      "jarpeekDump",
    ];

    let result: RunResult;
    try {
      result = await exec(candidate.command, args, { timeoutMs, cwd: projectRoot });
    } catch (error) {
      if (error instanceof TimeoutError) {
        failures.push({ via: candidate.via, solo: "timeout", detail: "timeout" });
        continue;
      }
      if (error instanceof SpawnError) {
        // a spawn failure mid-run is an attempt failure, not absence — the
        // probe decided absence before anything spawned
        failures.push({
          via: candidate.via,
          solo: `gradle-failed:${error.message}`,
          detail: error.message,
        });
        continue;
      }
      throw error;
    }

    const fail = (solo: AttemptFailure["solo"], detail: string): void => {
      failures.push({ via: candidate.via, solo, detail });
    };

    if (result.code !== 0) {
      const detail = failureDetail(result);
      fail(`gradle-failed:${detail}`, detail);
      continue;
    }

    const payload = extractBetweenSentinels(result.stdout);
    if (payload === null) {
      fail("no-output", "no-output");
      continue;
    }

    let document: DumpDocument;
    try {
      document = JSON.parse(payload) as DumpDocument;
    } catch {
      fail("bad-json", "bad-json");
      continue;
    }
    return { ok: true, artifacts: mapArtifacts(document, projectRoot) };
  }

  // every candidate failed: one attempt keeps its solo reason, several name
  // each in one line
  if (failures.length === 1) return { ok: false, artifacts: [], reason: failures[0].solo };
  return {
    ok: false,
    artifacts: [],
    reason: `gradle-failed:${failures.map((f) => `${f.via}: ${f.detail}`).join(" | ")}`,
  };
}
