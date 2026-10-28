/**
 * Build discovery: which Gradle/Maven builds a directory means.
 *
 * Agents start in all kinds of places — a monorepo's root, a service's
 * source folder, a parent folder of several repos, a git worktree — and
 * none of them should need setup. Two moves cover every case:
 *
 * - **Up.** Inside a build, the build root encloses the start: Gradle's
 *   rule (nearest `settings.gradle[.kts]`, else the nearest
 *   `build.gradle[.kts]`) and Maven's (nearest `.mvn/` beside a pom, else
 *   the outermost directory of the contiguous chain of pom-bearing
 *   parents). The walk stops at the repository root (`.git`).
 * - **Down.** Above builds (a monorepo or multi-repo root), every build
 *   root below the start: `git ls-files` inside a repository (fast,
 *   honors .gitignore; nested repositories are walked on their own),
 *   otherwise a bounded directory walk. Descent stops at a build root —
 *   its modules belong to it — and test-fixture projects are not builds.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { detectBuildSystems, type BuildSystem } from "../resolver/detect.js";

export interface DiscoveredBuild {
  /** Absolute build root. */
  root: string;
  /** `/`-separated path relative to the workspace directory ("." for the directory itself). */
  rel: string;
  systems: BuildSystem[];
}

/** Marker files that make a directory part of a build. */
const MARKERS = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "pom.xml"];
const MARKER_SET = new Set(MARKERS);

/** Directories never descended into by the walk-down. */
const SKIP_DIRS = new Set(["node_modules", "target", "build", "out", "dist", "bin", "vendor"]);

/**
 * Path segments marking a test-fixture project: a `pom.xml` under
 * `test/fixtures/` is sample input for a tool's tests, not a build of the
 * workspace.
 */
const FIXTURE_SEGMENTS = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "test-fixtures"]);

/** Builds discovered beyond this many are dropped (and the cap is reported). */
export const MAX_BUILDS = 64;

/** Walk-down depth when not inside a git repository. */
const MAX_WALK_DEPTH = 6;

const has = (dir: string, name: string): boolean => existsSync(join(dir, name));

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The enclosing build root of `start`, or null when `start` is not inside a build. */
export function enclosingBuild(start: string): string | null {
  const ancestors: string[] = [];
  const home = resolve(homedir());
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    ancestors.push(dir);
    // the repository root (or, outside one, the home directory) is the
    // outermost place a build can enclose from: a stray build file in ~
    // must not swallow every folder under it
    if (has(dir, ".git") || dir === home || dirname(dir) === dir) break;
  }

  let gradle: string | null = null;
  const settings = ancestors.find((d) => has(d, "settings.gradle") || has(d, "settings.gradle.kts"));
  if (settings !== undefined) gradle = settings;
  else gradle = ancestors.find((d) => has(d, "build.gradle") || has(d, "build.gradle.kts")) ?? null;

  let maven: string | null = null;
  const dotMvn = ancestors.find((d) => isDir(join(d, ".mvn")) && has(d, "pom.xml"));
  if (dotMvn !== undefined) {
    maven = dotMvn;
  } else {
    const first = ancestors.findIndex((d) => has(d, "pom.xml"));
    if (first !== -1) {
      let top = first;
      while (top + 1 < ancestors.length && has(ancestors[top + 1]!, "pom.xml")) top++;
      maven = ancestors[top]!;
    }
  }

  if (gradle === null) return maven;
  if (maven === null) return gradle;
  // both families above the start: the deeper root is the more specific build
  return gradle.length >= maven.length ? gradle : maven;
}

function isFixturePath(relDir: string): boolean {
  const parts = relDir.split("/");
  if (parts.some((part) => FIXTURE_SEGMENTS.has(part))) return true;
  // src/test/... and src/it/... hold test projects of the enclosing build
  return parts.some((part, i) => part === "src" && (parts[i + 1] === "test" || parts[i + 1] === "it"));
}

/** Marker directories under `dir` (relative, `/`-separated) via git, or null outside a repository. */
function markersViaGit(dir: string): { dirs: string[]; nested: string[] } | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "-C",
        dir,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
        "-z",
        "--",
        ...MARKERS.flatMap((m) => [`:(glob)${m}`, `:(glob)**/${m}`]),
        // untracked nested repositories surface as directories ("repo/")
        ":(glob)**/",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  const dirs = new Set<string>();
  const nested: string[] = [];
  for (const entry of out.split("\0")) {
    if (entry.length === 0) continue;
    if (entry.endsWith("/")) {
      // a wholly untracked directory: a nested repository, or new files
      // git reports as one entry — either way, look inside it directly
      const candidate = entry.slice(0, -1);
      if (has(join(dir, candidate), ".git")) nested.push(candidate);
      else for (const inner of markersViaWalk(join(dir, candidate))) dirs.add(inner.length > 0 ? `${candidate}/${inner}` : candidate);
      continue;
    }
    const slash = entry.lastIndexOf("/");
    const name = slash === -1 ? entry : entry.slice(slash + 1);
    if (MARKER_SET.has(name)) dirs.add(slash === -1 ? "" : entry.slice(0, slash));
  }
  return { dirs: [...dirs], nested };
}

/** Marker directories under `dir` via a bounded directory walk. */
function markersViaWalk(dir: string): string[] {
  const dirs: string[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    let entries: Array<Dirent<string>>;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && MARKER_SET.has(e.name))) {
      dirs.push(rel);
      return; // a build root owns everything below it
    }
    if (depth >= MAX_WALK_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(join(abs, entry.name), rel.length > 0 ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  walk(dir, "", 0);
  return dirs;
}

/** Keep the shallowest marker directories: anything below an accepted root belongs to it. */
function topLevel(relDirs: string[]): string[] {
  const sorted = [...new Set(relDirs)]
    .filter((d) => !isFixturePath(d))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const accepted: string[] = [];
  for (const d of sorted) {
    if (accepted.some((root) => root === "" || d === root || d.startsWith(`${root}/`))) continue;
    accepted.push(d);
  }
  return accepted;
}

/** Absolute build roots below `dir` (inclusive), shallowest first. */
export function buildsBelow(dir: string): string[] {
  const root = resolve(dir);
  const viaGit = markersViaGit(root);
  let rels: string[];
  if (viaGit === null) {
    rels = markersViaWalk(root);
  } else {
    rels = [...viaGit.dirs];
    for (const nested of viaGit.nested) {
      for (const inner of buildsBelow(join(root, nested))) {
        rels.push(relative(root, inner).split(sep).join("/"));
      }
    }
  }
  return topLevel(rels).map((rel) => (rel.length === 0 ? root : join(root, ...rel.split("/"))));
}

function describe(workspace: string, root: string): DiscoveredBuild {
  const rel = relative(workspace, root).split(sep).join("/");
  return { root, rel: rel.length === 0 ? "." : rel, systems: detectBuildSystems(root) };
}

export interface Discovery {
  builds: DiscoveredBuild[];
  /** How the builds were found: enclosing the directory, below it, or none at all. */
  via: "enclosing" | "below" | "none";
  /** True when more than MAX_BUILDS were found and the list was cut. */
  truncated: boolean;
}

/** The builds `dir` means: the one enclosing it, else every build below it. */
export function discoverBuilds(dir: string): Discovery {
  const workspace = resolve(dir);
  const enclosing = enclosingBuild(workspace);
  if (enclosing !== null) {
    // the directory is inside this build: to the caller it IS the build
    const build = { ...describe(workspace, enclosing), rel: "." };
    return { builds: [build], via: "enclosing", truncated: false };
  }
  const below = buildsBelow(workspace);
  if (below.length === 0) return { builds: [], via: "none", truncated: false };
  return {
    builds: below.slice(0, MAX_BUILDS).map((root) => describe(workspace, root)),
    via: "below",
    truncated: below.length > MAX_BUILDS,
  };
}
