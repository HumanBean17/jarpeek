/**
 * Maven resolver — asks the project's own POM where its dependencies live.
 *
 * `dependency:build-classpath` prints the effective classpath (one jar per
 * path entry) into a temp file, which this module reverse-maps into m2
 * coordinates by path layout. `dependency:sources` then populates the local
 * repository with `-sources` jars; it is best-effort — its exit code is
 * ignored. Multi-module projects run the goal once at the root plus once per
 * depth-1 submodule and merge, because the root run only covers the root
 * POM. Everything degrades rather than fails: no mvn anywhere, a timeout, a
 * failed build, or an empty classpath each become `{ ok: false, reason }`.
 */
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";
import { runWithTimeout, SpawnError, TimeoutError, type RunResult } from "../util/exec.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 500;

export interface MavenResolution {
  ok: boolean;
  artifacts: DependencyArtifact[];
  reason?: "no-mvn" | "timeout" | `mvn-failed:${string}` | "no-classpath";
}

export interface ResolveMavenOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real spawner. */
  exec?: typeof runWithTimeout;
  /** m2 repository root anchoring the layout reverse-map; default `~/.m2/repository`. */
  m2Dir?: string;
  /** Injectable PATH probe consulted before the bare-mvn fallback. */
  mvnOnPath?: () => boolean;
}

interface SelectedCommand {
  command: string;
  /** Platform plumbing that precedes the mvn args (e.g. `/c mvnw.cmd`). */
  preArgs: string[];
  /** True when neither wrapper exists and bare `mvn` is the command. */
  bare: boolean;
}

/**
 * mvn selection: `mvnw.cmd` through `cmd /c` on win32 (.cmd files cannot be
 * spawned directly), `mvnw` elsewhere, bare `mvn` as the last resort — on
 * win32 the bare fallback also goes through `cmd` so an mvn.cmd on PATH is
 * reachable; its absence is caught by the PATH probe before anything spawns.
 */
function selectCommand(projectRoot: string): SelectedCommand {
  if (process.platform === "win32") {
    const cmd = join(projectRoot, "mvnw.cmd");
    if (existsSync(cmd)) return { command: "cmd", preArgs: ["/c", cmd], bare: false };
    return { command: "cmd", preArgs: ["/c", "mvn"], bare: true };
  }
  const sh = join(projectRoot, "mvnw");
  if (existsSync(sh)) return { command: sh, preArgs: [], bare: false };
  return { command: "mvn", preArgs: [], bare: true };
}

/**
 * PATH probe for a system Maven, consulted only when no wrapper exists: on
 * win32 any PATHEXT match (mvn.cmd/.bat/.exe) counts, elsewhere the `mvn`
 * binary must exist and be executable somewhere on PATH.
 */
export function mvnOnPathDefault(): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  if (process.platform === "win32") {
    const exts = (process.env.PATHEXT ?? ".com;.exe;.bat;.cmd")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0);
    return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, `mvn${ext}`))));
  }
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, "mvn"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : trimmed.slice(-STDERR_TAIL_CHARS);
}

/**
 * Classpath entries of a cp.txt: `;`-joined when the content carries a `;`
 * (windows output), `:`-joined otherwise. Whitespace-only content yields [].
 */
function splitClasspath(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  const separator = content.includes(";") ? ";" : ":";
  return trimmed
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `/`-separated form of a path, for layout parsing on either platform. */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

interface M2Coordinates {
  group: string;
  artifact: string;
  version: string;
}

/**
 * Reverse-map a classpath entry onto m2 coordinates by layout: the entry must
 * sit under `m2Dir` as `<group…>/<artifact>/<version>/<artifact>-<version>.jar`
 * with the group variable-depth (`org/apache/kafka` → `org.apache.kafka`).
 * The anchor is required — without it any `<g>/<a>/<v>/<a>-<v>.jar` tail
 * anywhere on disk would match and pollute the group with path prefixes.
 * Anything else (system-scoped jars, IDE caches) returns null and is skipped.
 * The prefix comparison is case-insensitive: windows maven output may spell
 * the drive differently than `homedir()` did.
 */
function parseM2Entry(raw: string, m2Dir: string): M2Coordinates | null {
  const normalized = toForwardSlashes(raw);
  const root = toForwardSlashes(m2Dir).replace(/\/+$/, "");
  if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  const parts = normalized.slice(root.length + 1).split("/");
  if (parts.length < 3) return null;
  const file = parts[parts.length - 1];
  const version = parts[parts.length - 2];
  const artifact = parts[parts.length - 3];
  if (file !== `${artifact}-${version}.jar`) return null;
  const group = parts.slice(0, parts.length - 3).join(".");
  if (group.length === 0) return null;
  return { group, artifact, version };
}

/**
 * Sibling `<artifact>-<version>-sources.jar` in the jar's own version
 * directory when it exists, preserving the entry's original separators.
 */
function sourcesSibling(raw: string, artifact: string, version: string): string | undefined {
  const lastSlash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  if (lastSlash === -1) return undefined;
  const dir = raw.slice(0, lastSlash);
  const candidate = `${dir}${raw[lastSlash]}${artifact}-${version}-sources.jar`;
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Depth-1 submodule directories (immediate children holding a pom.xml),
 * lexically sorted for deterministic invocation order.
 */
function submodules(projectRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(projectRoot, entry.name))
    .filter((dir) => existsSync(join(dir, "pom.xml")))
    .sort();
}

/**
 * Parse the collected build-classpath outputs into artifacts, deduplicated by
 * coordinates with the first module in run order winning. An output that is
 * missing or empty contributes nothing; only when every output was empty is
 * the resolution a `no-classpath` failure (the root POM may legitimately be
 * a dep-less aggregator whose submodules carry everything).
 */
function parseOutputs(outputs: string[], m2Dir: string): MavenResolution {
  const byCoordinates = new Map<string, DependencyArtifact>();
  let sawContent = false;
  for (const output of outputs) {
    let content: string;
    try {
      content = readFileSync(output, "utf8");
    } catch {
      continue;
    }
    if (content.trim().length === 0) continue;
    sawContent = true;
    for (const raw of splitClasspath(content)) {
      const hit = parseM2Entry(raw, m2Dir);
      if (hit === null) continue; // non-m2 layout: skipped silently (v1)
      const coordinates = `${hit.group}:${hit.artifact}:${hit.version}`;
      if (byCoordinates.has(coordinates)) continue;
      const sourcesJar = sourcesSibling(raw, hit.artifact, hit.version);
      byCoordinates.set(coordinates, {
        coordinates,
        configuration: "compile+runtime+test", // one effective classpath per run
        kind: "external",
        binaryJar: raw,
        ...(sourcesJar !== undefined ? { sourcesJar } : {}),
        provenance: sourcesJar !== undefined ? "source" : "signature",
        warnings: [],
      });
    }
  }
  if (!sawContent) return { ok: false, artifacts: [], reason: "no-classpath" };
  return { ok: true, artifacts: [...byCoordinates.values()] };
}

/**
 * Resolve a Maven project's dependencies. The build-classpath goal runs once
 * at the project root plus once per depth-1 submodule (per-module output
 * files, merged by coordinates); `dependency:sources` then runs once at the
 * root — enough for a reactor — with its exit code ignored. Every recognized
 * failure mode — no mvn anywhere, timeout, spawn failure, non-zero exit,
 * empty classpath — becomes `{ ok: false, reason }`; an unexpected error
 * thrown by `exec` itself propagates to the caller.
 */
export async function resolveMaven(
  projectRoot: string,
  opts: ResolveMavenOptions = {},
): Promise<MavenResolution> {
  const exec = opts.exec ?? runWithTimeout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const m2Dir = opts.m2Dir ?? join(homedir(), ".m2", "repository");

  const selected = selectCommand(projectRoot);
  if (selected.bare && !(opts.mvnOnPath ?? mvnOnPathDefault)()) {
    return { ok: false, artifacts: [], reason: "no-mvn" };
  }

  const scratch = mkdtempSync(join(tmpdir(), "jarpeek-mvn-"));
  const outputs: string[] = [];
  try {
    for (const [index, moduleDir] of [projectRoot, ...submodules(projectRoot)].entries()) {
      const output = join(scratch, `cp-${index}.txt`);
      outputs.push(output);
      const args = [
        ...selected.preArgs,
        "-B",
        "-q",
        "dependency:build-classpath",
        `-Dmdep.outputFile=${output}`,
      ];
      let result: RunResult;
      try {
        result = await exec(selected.command, args, { timeoutMs, cwd: moduleDir });
      } catch (error) {
        if (error instanceof TimeoutError) {
          return { ok: false, artifacts: [], reason: "timeout" };
        }
        if (error instanceof SpawnError) {
          // bare mvn that cannot spawn despite a passing probe = treat as
          // absence; an existing wrapper that fails to exec is a build failure
          if (selected.bare) return { ok: false, artifacts: [], reason: "no-mvn" };
          return { ok: false, artifacts: [], reason: `mvn-failed:${error.message}` };
        }
        throw error;
      }
      if (result.code !== 0) {
        let tail = stderrTail(result.stderr);
        if (tail.length === 0 && result.code === null) tail = "(killed)"; // signal-killed, no diagnosis
        return { ok: false, artifacts: [], reason: `mvn-failed:${tail}` };
      }
    }

    // best-effort sources population; exit code and throw both ignored
    try {
      await exec(
        selected.command,
        [...selected.preArgs, "-B", "-q", "dependency:sources", "-DincludeScope=test"],
        { timeoutMs, cwd: projectRoot },
      );
    } catch {
      // tolerated: pairing simply falls back to whatever sources already exist
    }

    return parseOutputs(outputs, m2Dir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
