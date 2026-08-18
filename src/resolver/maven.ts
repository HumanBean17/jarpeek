/**
 * Maven resolver — asks the project's own POM where its dependencies live.
 *
 * One reactor-wide `dependency:build-classpath` run at the project root
 * writes the effective classpath of every module: a RELATIVE
 * `-Dmdep.outputFile` resolves against each module's basedir, so each module
 * drops its own `target/jarpeek-classpath.txt` while keeping the reactor
 * context that maps sibling dependencies onto their `target/classes` (a
 * per-module `--non-recursive` run would lose that context and fail on any
 * sibling never installed to the local repository). `-fae` keeps the reactor
 * going past a failing module; its failure degrades the resolution (`partial`)
 * instead of discarding the modules that resolved. The collected files are
 * reverse-mapped into m2 coordinates by path layout. `dependency:sources`
 * then runs once at the root to populate the local repository with
 * `-sources` jars; it is best-effort — its exit code is ignored. Everything
 * degrades rather than fails: no mvn anywhere, a timeout, a fully failed
 * build, or an empty classpath each become `{ ok: false, reason }`.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import type { DependencyArtifact } from "../core/types.js";
import { moduleCoordinates } from "./module-coordinate.js";
import { runWithTimeout, SpawnError, TimeoutError, type RunResult } from "../util/exec.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const STDERR_TAIL_CHARS = 500;
/** Per-module classpath output, relative to each module's basedir (forward slashes: the mojo normalizes). */
const CP_FILE_REL = "target/jarpeek-classpath.txt";

export interface MavenResolution {
  ok: boolean;
  artifacts: DependencyArtifact[];
  reason?: "no-mvn" | "timeout" | `mvn-failed:${string}` | "no-classpath";
  /**
   * Set when the run partially failed: some modules resolved (artifacts is
   * trustworthy) but at least one module's resolution failed, so its unique
   * dependencies are missing. Names the failed module directories.
   */
  partial?: string;
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
 * Diagnosis text for a failed mvn run, never empty: the stderr tail, else
 * the stdout tail (a quiet `-q` run may print its only error there), else a
 * marker naming the exit code — a signal kill says `(killed)` since it has
 * none. The reason is what a user reads when resolution degrades, so an
 * empty `mvn-failed:` would hide the failure entirely.
 */
function failureDetail(result: RunResult): string {
  const tail = stderrTail(result.stderr);
  if (tail.length > 0) return tail;
  const out = stderrTail(result.stdout);
  if (out.length > 0) return out;
  return result.code === null ? "(killed)" : `exit ${result.code} (no output)`;
}

/** A windows drive-letter root: `C:\` or `C:/`. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Classpath entries of a cp.txt: `;`-joined windows output, `:`-joined unix.
 * The windows decision cannot rest on `;` alone — a one-dependency project
 * emits a single entry with no separator at all, and splitting that on `:`
 * would shred the drive letter into two unmatchable halves — so a leading
 * drive-letter pattern counts as windows too. Whitespace-only yields [].
 */
function splitClasspath(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  const windows = content.includes(";") || WINDOWS_DRIVE.test(trimmed);
  const separator = windows ? ";" : ":";
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
 * Module directories under the root: every directory holding its own
 * pom.xml, discovered recursively to depth ≤ 3 so nested reactors
 * (`root/a/a1`) resolve too. Dot-directories are skipped; the list is
 * lexically sorted for deterministic invocation order.
 */
function moduleDirs(projectRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "pom.xml"))) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk(projectRoot, 1);
  return found.sort();
}

/**
 * Reverse-map a reactor classpath entry onto the module directory whose
 * compiled output it is (`<module>/target/classes`), or null when the entry
 * is not a module's classes. Comparison is on `/`-normalized paths,
 * case-insensitive like the m2 anchor: windows maven output may spell the
 * drive differently than the directory walk did.
 */
function matchModuleClasses(raw: string, modules: string[]): string | null {
  const normalized = toForwardSlashes(raw).replace(/\/+$/, "");
  for (const moduleDir of modules) {
    const base = `${toForwardSlashes(moduleDir)}/target/classes`;
    if (normalized.toLowerCase() === base.toLowerCase()) return moduleDir;
  }
  return null;
}

/**
 * Parse the collected build-classpath outputs into artifacts, deduplicated by
 * coordinates with the first module in discovery order winning. A sibling
 * reactor module appears as its `<module>/target/classes` output — mapped to
 * a `kind: "module"` artifact on the module directory itself, so its sources
 * are indexed in place exactly like a Gradle module's. An output that is
 * missing or empty contributes nothing; only when every output was empty is
 * the resolution a `no-classpath` failure (the root POM may legitimately be
 * a dep-less aggregator whose submodules carry everything). Outputs that
 * carried entries but matched neither m2 layout nor a module directory mean
 * the local repository was relocated out of `~/.m2/repository` — reported as
 * a named failure rather than a misleading empty success.
 */
function parseOutputs(outputs: string[], m2Dir: string, projectRoot: string, modules: string[]): MavenResolution {
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
      if (hit === null) {
        // a reactor sibling's compiled output is the module itself, not an
        // external jar; anything else (system-scoped jars, IDE caches) is
        // skipped silently (v1)
        const moduleDir = matchModuleClasses(raw, modules);
        if (moduleDir !== null) {
          const coordinates = moduleCoordinates(
            projectRoot,
            relative(projectRoot, moduleDir).replaceAll("\\", "/"),
          );
          if (!byCoordinates.has(coordinates)) {
            byCoordinates.set(coordinates, {
              coordinates,
              configuration: "compile+runtime+test",
              kind: "module",
              sourceDir: moduleDir,
            });
          }
        }
        continue;
      }
      const coordinates = `${hit.group}:${hit.artifact}:${hit.version}`;
      if (byCoordinates.has(coordinates)) continue;
      const sourcesJar = sourcesSibling(raw, hit.artifact, hit.version);
      byCoordinates.set(coordinates, {
        coordinates,
        configuration: "compile+runtime+test", // one effective classpath per run
        kind: "external",
        binaryJar: raw,
        ...(sourcesJar !== undefined ? { sourcesJar } : {}),
      });
    }
  }
  if (!sawContent) return { ok: false, artifacts: [], reason: "no-classpath" };
  if (byCoordinates.size === 0) {
    return { ok: false, artifacts: [], reason: "mvn-failed:classpath-not-in-m2-layout" };
  }
  return { ok: true, artifacts: [...byCoordinates.values()] };
}

/** Absolute path of a directory's classpath output file. */
function cpFile(dir: string): string {
  return join(dir, ...CP_FILE_REL.split("/"));
}

/**
 * Resolve a Maven project's dependencies. One reactor-wide
 * `dependency:build-classpath` run at the project root writes
 * `<module>/target/jarpeek-classpath.txt` for the root and every module
 * directory (recursive to depth 3); `-fae` keeps the reactor going past a
 * failing module, whose failure degrades to `partial` instead of discarding
 * the modules that resolved. `dependency:sources` then runs once at the
 * root — enough for a reactor — with its exit code ignored. Every recognized
 * failure mode — no mvn anywhere, timeout, spawn failure, a fully failed
 * build, an empty classpath, or a classpath outside the m2 layout — becomes
 * `{ ok: false, reason }`; an unexpected error thrown by `exec` itself
 * propagates to the caller.
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

  const modules = moduleDirs(projectRoot);
  const targets = [projectRoot, ...modules].map(cpFile);
  // a file left by a crashed previous run must not pass for this run's
  // output; `target/` is pre-created so the mojo can always write into it
  // (a read-only tree skips the mkdir and the run itself will say why)
  for (const target of targets) {
    rmSync(target, { force: true });
    try {
      mkdirSync(join(target, ".."), { recursive: true });
    } catch {
      // unwritable: the mvn run's failure detail will carry the story
    }
  }
  try {
    let result: RunResult;
    try {
      result = await exec(
        selected.command,
        [
          ...selected.preArgs,
          "-B",
          "-q",
          "-fae",
          "dependency:build-classpath",
          `-Dmdep.outputFile=${CP_FILE_REL}`,
        ],
        { timeoutMs, cwd: projectRoot },
      );
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

    const outputs = targets.filter((target) => existsSync(target));
    const parsed = parseOutputs(outputs, m2Dir, projectRoot, modules);
    if (!parsed.ok) {
      // nothing survived the run: with a non-zero exit the mvn failure is
      // the reason, else every module simply produced an empty classpath
      return result.code !== 0
        ? { ok: false, artifacts: [], reason: `mvn-failed:${failureDetail(result)}` }
        : parsed;
    }

    // best-effort sources population; exit code and throw both ignored — it
    // runs on partial resolutions too: everything that resolved deserves its
    // sources even when a sibling module failed
    try {
      await exec(
        selected.command,
        [...selected.preArgs, "-B", "-q", "dependency:sources", "-DincludeScope=test"],
        { timeoutMs, cwd: projectRoot },
      );
    } catch {
      // tolerated: pairing simply falls back to whatever sources already exist
    }

    if (result.code !== 0) {
      const failed = [projectRoot, ...modules]
        .filter((dir) => !existsSync(cpFile(dir)))
        .map((dir) => (dir === projectRoot ? "." : relative(projectRoot, dir)))
        .join(", ");
      return { ...parsed, partial: `modules failed to resolve: ${failed}` };
    }
    return parsed;
  } finally {
    for (const target of targets) rmSync(target, { force: true });
  }
}
