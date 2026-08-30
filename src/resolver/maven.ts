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
 * reverse-mapped into m2 coordinates by path layout, anchored on the roots
 * convergence's candidate list (see `roots.ts`: env, configs, settings.xml,
 * default) — and when no candidate matches, on an anchor derived from mvn's
 * own output (quorum-guaranteed, reported as a warning). `dependency:sources`
 * then runs once at the root to populate the local repository with
 * `-sources` jars; it is best-effort — its exit code is ignored.
 *
 * Which mvn runs is the build-tool strategy (see `strategy.ts`): the system
 * mvn from PATH first when its probe passes, the root wrapper as fallback —
 * and a failed first attempt (any cause) advances to the next candidate, so
 * a version-skewed system mvn fails over to the wrapper inside one
 * resolution. A forced `wrapper` with no wrapper file, or a forced `system`
 * with a failing probe, is an immediate named absence. Everything degrades
 * rather than fails: absence, a timeout, a spawn failure, a fully failed
 * build, or an empty classpath each become `{ ok: false, reason }` — naming
 * every attempt when more than one ran.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";
import type { DependencyArtifact } from "../core/types.js";
import { moduleCoordinates } from "./module-coordinate.js";
import { effectiveM2Roots } from "./roots.js";
import type { BuildToolStrategy } from "./strategy.js";
import { runWithTimeout, SpawnError, TimeoutError, type RunResult } from "../util/exec.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const STDERR_TAIL_CHARS = 500;
/** Per-module classpath output, relative to each module's basedir (forward slashes: the mojo normalizes). */
const CP_FILE_REL = "target/jarpeek-classpath.txt";

export interface MavenResolution {
  ok: boolean;
  artifacts: DependencyArtifact[];
  reason?: "no-mvn" | "no-wrapper" | "timeout" | `mvn-failed:${string}` | "no-classpath";
  /**
   * Set when the run partially failed: some modules resolved (artifacts is
   * trustworthy) but at least one module's resolution failed, so its unique
   * dependencies are missing. Names the failed module directories.
   */
  partial?: string;
  /**
   * Non-fatal observations the caller should surface as warnings — today
   * only `maven: m2-anchor-derived:<path>`: the anchor came from mvn's own
   * output because no configured root matched (see `roots.ts`).
   */
  warnings?: string[];
}

export interface ResolveMavenOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real spawner. */
  exec?: typeof runWithTimeout;
  /**
   * m2 repository root anchoring the layout reverse-map; top-precedence
   * override of the roots convergence (see `roots.ts`).
   */
  m2Dir?: string;
  /**
   * The full m2 anchor list, threaded by the resolver facade — replaces the
   * self-computed convergence entirely when present.
   */
  roots?: { m2: string[] };
  /** Injectable PATH probe consulted whenever the system mvn is a candidate. */
  mvnOnPath?: () => boolean;
  /** Which mvn runs resolves; undefined means `auto` (system first, wrapper fallback). */
  strategy?: BuildToolStrategy;
}

/** One mvn command the resolver may run, tagged with where it came from. */
interface Candidate {
  via: "system" | "wrapper";
  command: string;
  /** Platform plumbing that precedes the mvn args (e.g. `/c mvnw.cmd`). */
  preArgs: string[];
}

/** The root wrapper when present: `mvnw.cmd` through `cmd /c` on win32 (.cmd files cannot be spawned directly), `mvnw` elsewhere. */
function wrapperCandidate(projectRoot: string): Candidate | null {
  if (process.platform === "win32") {
    const cmd = join(projectRoot, "mvnw.cmd");
    return existsSync(cmd) ? { via: "wrapper", command: "cmd", preArgs: ["/c", cmd] } : null;
  }
  const sh = join(projectRoot, "mvnw");
  return existsSync(sh) ? { via: "wrapper", command: sh, preArgs: [] } : null;
}

/** The system mvn: on win32 through `cmd` so an mvn.cmd on PATH is reachable; its absence is caught by the PATH probe before anything spawns. */
function systemCandidate(): Candidate {
  return process.platform === "win32"
    ? { via: "system", command: "cmd", preArgs: ["/c", "mvn"] }
    : { via: "system", command: "mvn", preArgs: [] };
}

/**
 * PATH probe for a system Maven, consulted whenever the system mvn is a
 * candidate (auto and system strategies): on win32 any PATHEXT match
 * (mvn.cmd/.bat/.exe) counts, elsewhere the `mvn` binary must exist and be
 * executable somewhere on PATH.
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

/** Whether a forward-slashed entry's last three segments satisfy the m2 filename contract (`<a>/<v>/<a>-<v>.jar`). */
function isLayoutShaped(normalized: string): boolean {
  const parts = normalized.split("/");
  if (parts.length < 4) return false;
  const [artifact, version, file] = parts.slice(-3);
  return file === `${artifact}-${version}.jar`;
}

/** A directory segment that names a repository: `m2`, `repository`, `custom-m2`, `my-repository`, … */
function isRepoSegment(segment: string): boolean {
  return /^(.*[._-])?m2$/i.test(segment) || /^(.*[._-])?repo(sitory)?$/i.test(segment);
}

/**
 * The anchor mvn's own output reveals when no configured root matched: the
 * common path prefix of the layout-shaped entries, popped back until every
 * voter keeps at least one group segment below it, then — among the levels
 * above that stay valid — the DEEPEST one ending in a repository-named
 * segment (`…/custom-m2`, `…/repo`). The name signal separates the root from
 * a group level every voter shares (`…/m2/org` for an all-org classpath);
 * without it the deepest valid level stands, which merely folds that shared
 * segment into the group string. Quorum of two distinct entries: a lone
 * layout-shaped system-scoped jar must not conjure a root — the protection
 * the fixed anchor always provided. Undefined when no anchor survives (no
 * quorum, or a prefix degenerated to the filesystem root).
 */
function voteDerivedAnchor(entries: string[]): string | undefined {
  const voters = [...new Set(entries.map(toForwardSlashes).filter(isLayoutShaped))];
  if (voters.length < 2) return undefined;
  let prefix = voters[0].split("/");
  for (const voter of voters.slice(1)) {
    const parts = voter.split("/");
    // first index where they disagree truncates the prefix
    let cut = 0;
    while (cut < prefix.length && cut < parts.length && prefix[cut] === parts[cut]) cut++;
    prefix = prefix.slice(0, cut);
  }
  while (prefix.length > 0 && voters.some((voter) => voter.split("/").length - prefix.length < 4)) {
    prefix.pop();
  }
  for (let depth = prefix.length; depth >= 1; depth--) {
    const anchor = prefix.slice(0, depth).join("/");
    if (anchor.length > 0 && !/^[A-Za-z]:$/.test(anchor) && isRepoSegment(prefix[depth - 1])) {
      return anchor;
    }
  }
  const anchor = prefix.join("/");
  return anchor.length > 0 && !/^[A-Za-z]:$/.test(anchor) ? anchor : undefined;
}

/**
 * Parse the collected build-classpath outputs into artifacts, deduplicated by
 * coordinates with the first module in discovery order winning. Each entry is
 * matched against EVERY anchor in `m2Dirs` (the roots convergence's candidate
 * list — env, configs, settings.xml, default) with the first match winning.
 * A sibling reactor module appears as its `<module>/target/classes` output —
 * mapped to a `kind: "module"` artifact on the module directory itself, so
 * its sources are indexed in place exactly like a Gradle module's. An output
 * that is missing or empty contributes nothing; only when every output was
 * empty is the resolution a `no-classpath` failure (the root POM may
 * legitimately be a dep-less aggregator whose submodules carry everything).
 * Entries that carried content but matched no anchor and no module trigger
 * anchor DERIVATION: mvn's own output votes on the root it used (quorum 2),
 * the winner joins the anchor list, and the resolution carries a
 * `m2-anchor-derived` warning. Only when derivation also fails does the
 * resolution report `classpath-not-in-m2-layout`.
 */
function parseOutputs(outputs: string[], m2Dirs: string[], projectRoot: string, modules: string[]): MavenResolution {
  const entries: string[] = [];
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
    entries.push(...splitClasspath(content));
  }

  /** One anchored mapping pass: first matching anchor wins per entry. */
  const map = (anchors: string[]): Map<string, DependencyArtifact> => {
    const byCoordinates = new Map<string, DependencyArtifact>();
    for (const raw of entries) {
      let hit: { group: string; artifact: string; version: string } | null = null;
      for (const anchor of anchors) {
        hit = parseM2Entry(raw, anchor);
        if (hit !== null) break;
      }
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
    return byCoordinates;
  };

  let byCoordinates = map(m2Dirs);
  let derivedWarning: string | undefined;
  if (sawContent && byCoordinates.size === 0) {
    const derived = voteDerivedAnchor(entries);
    if (derived !== undefined) {
      byCoordinates = map([...m2Dirs, derived]);
      derivedWarning = `maven: m2-anchor-derived:${derived}`;
    }
  }
  if (!sawContent) return { ok: false, artifacts: [], reason: "no-classpath" };
  if (byCoordinates.size === 0) {
    return { ok: false, artifacts: [], reason: "mvn-failed:classpath-not-in-m2-layout" };
  }
  return {
    ok: true,
    artifacts: [...byCoordinates.values()],
    ...(derivedWarning !== undefined ? { warnings: [derivedWarning] } : {}),
  };
}

/** Absolute path of a directory's classpath output file. */
function cpFile(dir: string): string {
  return join(dir, ...CP_FILE_REL.split("/"));
}

/** One candidate's failure: its solo reason, plus the bare detail for the combined form. */
interface AttemptFailure {
  via: "system" | "wrapper";
  /** Exactly what this attempt would have returned had it run alone. */
  solo: Exclude<MavenResolution["reason"], undefined>;
  /** The same failure without the `mvn-failed:` prefix, for the combined reason. */
  detail: string;
}

/** `detail` for a parse failure: its reason minus any `mvn-failed:` prefix. */
function parseFailureDetail(reason: Exclude<MavenResolution["reason"], undefined>): string {
  return reason.startsWith("mvn-failed:") ? reason.slice("mvn-failed:".length) : reason;
}

/**
 * Resolve a Maven project's dependencies. One reactor-wide
 * `dependency:build-classpath` run at the project root writes
 * `<module>/target/jarpeek-classpath.txt` for the root and every module
 * directory (recursive to depth 3); `-fae` keeps the reactor going past a
 * failing module, whose failure degrades to `partial` instead of discarding
 * the modules that resolved. Candidates run in strategy order — the first
 * `ok` (including `partial`) wins and `dependency:sources` runs once on the
 * winner; any failure advances to the next candidate, and when every
 * candidate failed the reason names each attempt. Every recognized failure
 * mode — absence, timeout, spawn failure, a fully failed build, an empty
 * classpath, or a classpath outside the m2 layout — becomes
 * `{ ok: false, reason }`; an unexpected error thrown by `exec` itself
 * propagates to the caller.
 */
export async function resolveMaven(
  projectRoot: string,
  opts: ResolveMavenOptions = {},
): Promise<MavenResolution> {
  const exec = opts.exec ?? runWithTimeout;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const m2Dirs = opts.roots?.m2 ?? effectiveM2Roots(projectRoot, { m2Dir: opts.m2Dir }).map((c) => c.path);
  const strategy = opts.strategy ?? "auto";

  const wrapper = wrapperCandidate(projectRoot);
  let candidates: Candidate[];
  if (strategy === "wrapper") {
    if (wrapper === null) return { ok: false, artifacts: [], reason: "no-wrapper" };
    candidates = [wrapper];
  } else if (strategy === "system") {
    if (!(opts.mvnOnPath ?? mvnOnPathDefault)()) {
      return { ok: false, artifacts: [], reason: "no-mvn" };
    }
    candidates = [systemCandidate()];
  } else {
    candidates = [];
    if ((opts.mvnOnPath ?? mvnOnPathDefault)()) candidates.push(systemCandidate());
    if (wrapper !== null) candidates.push(wrapper);
    if (candidates.length === 0) return { ok: false, artifacts: [], reason: "no-mvn" };
  }

  const modules = moduleDirs(projectRoot);
  const targets = [projectRoot, ...modules].map(cpFile);
  const failures: AttemptFailure[] = [];

  try {
    for (const candidate of candidates) {
      // a file left by a crashed previous run — or by the candidate before
      // this one — must not pass for this run's output; `target/` is
      // pre-created so the mojo can always write into it (a read-only tree
      // skips the mkdir and the run itself will say why)
      for (const target of targets) {
        rmSync(target, { force: true });
        try {
          mkdirSync(join(target, ".."), { recursive: true });
        } catch {
          // unwritable: the mvn run's failure detail will carry the story
        }
      }

      let result: RunResult;
      try {
        result = await exec(
          candidate.command,
          [
            ...candidate.preArgs,
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
          failures.push({ via: candidate.via, solo: "timeout", detail: "timeout" });
          continue;
        }
        if (error instanceof SpawnError) {
          // a spawn failure mid-run is an attempt failure, not absence —
          // the probe decided absence before anything spawned
          failures.push({
            via: candidate.via,
            solo: `mvn-failed:${error.message}`,
            detail: error.message,
          });
          continue;
        }
        throw error;
      }

      const outputs = targets.filter((target) => existsSync(target));
      const parsed = parseOutputs(outputs, m2Dirs, projectRoot, modules);
      if (!parsed.ok) {
        // nothing survived this candidate: with a non-zero exit the mvn
        // failure is the story, else every module simply produced an empty
        // classpath — either way the next candidate gets its turn
        if (result.code !== 0) {
          const detail = failureDetail(result);
          failures.push({ via: candidate.via, solo: `mvn-failed:${detail}`, detail });
        } else {
          const solo = parsed.reason ?? "no-classpath";
          failures.push({ via: candidate.via, solo, detail: parseFailureDetail(solo) });
        }
        continue;
      }

      // best-effort sources population on the winning candidate; exit code
      // and throw both ignored — it runs on partial resolutions too:
      // everything that resolved deserves its sources even when a sibling
      // module failed
      try {
        await exec(
          candidate.command,
          [...candidate.preArgs, "-B", "-q", "dependency:sources", "-DincludeScope=test"],
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
    }

    // every candidate failed: one attempt keeps its solo reason, several
    // name each in one line — the caller's warning budget sees one string
    if (failures.length === 1) return { ok: false, artifacts: [], reason: failures[0].solo };
    return {
      ok: false,
      artifacts: [],
      reason: `mvn-failed:${failures.map((f) => `${f.via}: ${f.detail}`).join(" | ")}`,
    };
  } finally {
    for (const target of targets) rmSync(target, { force: true });
  }
}
