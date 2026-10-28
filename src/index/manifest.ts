/**
 * The resolved-dependency manifest, stored in the machine-wide cache and
 * shared by every checkout whose build files match.
 *
 * Content addressing: a manifest lives at `<cache>/manifests/<key>.json`,
 * the key being a sha256 over the build files' CONTENTS (never mtimes —
 * a fresh worktree checks every file out with a new mtime) plus the
 * effective build-tool strategy and m2 root. The main checkout, each git
 * worktree, and any clone at the same build files therefore share one
 * entry: a new worktree's first query is a cache hit, not a Gradle/Maven
 * run.
 *
 * Portability: the only checkout-specific data a manifest holds are the
 * build's own modules — their directories (under the build root) and their
 * coordinates' namespace (derived from the root's path). Both are stored as
 * tokens (`${root}`, `${ns}`) and rebased onto the reading checkout, so a
 * shared entry never points one worktree at another's sources.
 *
 * Stale serving: each build root also keeps a pointer to the last key it
 * wrote. When the build files change and no entry matches the new key, the
 * pointer's manifest is served flagged stale — the degradation ladder's
 * "serve the stale index" row survives content addressing.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { BuildToolStrategy } from "../resolver/strategy.js";
import type { DegradedEntry } from "../resolver/index.js";
import type { DependencyArtifact } from "../core/types.js";
import { moduleNamespace } from "../resolver/module-coordinate.js";
import { cacheDir } from "../util/cache-dir.js";

/** Layout version of a manifest file; bumps force a full re-resolve. */
const MANIFEST_VERSION = 2;
/**
 * Version of the cache key derivation and the portable (tokenized) layout.
 * Part of the key, so changing either never reads an old-format entry.
 */
const KEY_LAYOUT = "3";

/** Token for the build root inside a stored manifest's paths. */
const ROOT_TOKEN = "${root}";
/** Token for the build root's module namespace inside stored coordinates. */
const NS_TOKEN = "${ns}";

/** Entries unused this long are pruned on the next write. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A hit refreshes its entry's mtime (the prune clock) at most this often. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

export interface Manifest {
  version: 2;
  resolvedAt: string;
  dependencySetHash: string;
  artifacts: DependencyArtifact[];
  /**
   * Present when the resolution that wrote this manifest was partial — the
   * artifact list is trustworthy for what it contains but NOT exhaustive, so
   * a negative computed over it is not definitive. Carries the truncating
   * degraded entries (the Maven partial reason with failed modules and
   * cause, or the failures behind a cache-scan resolution); degraded
   * entries that do not truncate the winning set (a failed cascade
   * sibling) stay warnings and never land here. Absent means the
   * resolution's answer was complete.
   */
  incomplete?: DegradedEntry[];
}

/**
 * Build files at the root only: wrapper pins and Maven's project-level
 * configuration, all of which change what a resolve produces.
 */
const ROOT_ONLY_FILES = [
  "gradlew",
  "mvnw",
  "gradle/wrapper/gradle-wrapper.properties",
  ".mvn/maven.config",
  ".mvn/extensions.xml",
  ".mvn/wrapper/maven-wrapper.properties",
] as const;

/** Build files fingerprinted wherever they occur in the walked tree. */
const BUILD_FILE_NAMES = new Set([
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle.lockfile",
  "settings-gradle.lockfile",
]);

/**
 * Directories the fingerprint walk never enters: build outputs, dependency
 * trees, IDE state — and `src`, which never holds a build's own build files
 * but often holds test-fixture projects that are not part of the build.
 */
const SKIP_DIRS = new Set(["node_modules", "target", "build", "out", "dist", "bin", "src"]);

/**
 * Directory depth the fingerprint walk descends: the Maven resolver's module
 * walk reaches depth 3, and Gradle subprojects nest about as deep.
 */
const MAX_WALK_DEPTH = 4;

/** Per-file content digests, reused while (size, mtime, ctime) stay put. */
const digestMemo = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; digest: string }>();

function fileDigest(path: string): string | null {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  const memo = digestMemo.get(path);
  if (
    memo !== undefined &&
    memo.size === stats.size &&
    memo.mtimeMs === stats.mtimeMs &&
    memo.ctimeMs === stats.ctimeMs
  ) {
    return memo.digest;
  }
  let digest: string;
  try {
    digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
  digestMemo.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, digest });
  return digest;
}

/**
 * Existing build-file relpaths (`/`-separated): the root-only set plus every
 * build file the bounded walk finds, version catalogs (`gradle/*.toml`)
 * included.
 */
export function buildFiles(projectRoot: string): string[] {
  const found = new Set<string>();
  for (const rel of ROOT_ONLY_FILES) {
    try {
      if (statSync(join(projectRoot, rel)).isFile()) found.add(rel);
    } catch {
      // absent
    }
  }
  const walk = (dir: string, relDir: string, depth: number): void => {
    let entries: Array<Dirent<string>>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        if (BUILD_FILE_NAMES.has(entry.name)) found.add(rel);
        else if (entry.name.endsWith(".toml") && relDir.split("/").pop() === "gradle") found.add(rel);
        continue;
      }
      if (!entry.isDirectory() || depth >= MAX_WALK_DEPTH) continue;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), rel, depth + 1);
    }
  };
  walk(projectRoot, "", 0);
  return [...found].sort();
}

/**
 * The manifest key: sha256 hex over the sorted lines `<relpath>\t<content
 * sha256>` of the build files under `projectRoot`, plus the strategy, the
 * m2 root and the key layout version. Contents, not mtimes: identical build
 * files in another checkout yield the same key. A project with no build
 * files has nothing to share by: its key carries its own root path.
 */
export async function computeDependencySetHash(
  projectRoot: string,
  strategy: BuildToolStrategy,
  m2Root: string,
): Promise<string> {
  const files = buildFiles(projectRoot);
  const lines = files
    .map((rel) => `${rel}\t${fileDigest(join(projectRoot, rel)) ?? "(vanished)"}`)
    .concat(`strategy\t${strategy}`, `m2Root\t${m2Root}`, `layout\t${KEY_LAYOUT}`);
  // identical build files are what justifies sharing an entry; with none,
  // there is nothing to share by, so the key is pinned to this root
  if (files.length === 0) lines.push(`root\t${resolve(projectRoot)}`);
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// -- storage -------------------------------------------------------------------------

/** Where the manifest for `key` lives. */
export function manifestPath(key: string): string {
  return join(cacheDir(), "manifests", `${key}.json`);
}

/** The pointer to the last key a build root wrote (stale serving). */
function pointerPath(projectRoot: string): string {
  const id = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 24);
  return join(cacheDir(), "roots", `${id}.json`);
}

/** Every spelling of the build root a resolver may have printed (symlinked /tmp, etc.). */
function rootSpellings(projectRoot: string): string[] {
  const spellings = [resolve(projectRoot)];
  try {
    const real = realpathSync(projectRoot);
    if (!spellings.includes(real)) spellings.push(real);
  } catch {
    // root gone: the resolved spelling is all there is
  }
  return spellings;
}

/** `path` with the build root replaced by the root token, or unchanged when outside it. */
function tokenizePath(path: string, spellings: string[]): string {
  for (const root of spellings) {
    if (path === root) return ROOT_TOKEN;
    if (path.startsWith(root + sep)) {
      return `${ROOT_TOKEN}/${relative(root, path).split(sep).join("/")}`;
    }
  }
  return path;
}

function detokenizePath(path: string, root: string): string {
  if (path === ROOT_TOKEN) return root;
  if (path.startsWith(`${ROOT_TOKEN}/`)) return join(root, ...path.slice(ROOT_TOKEN.length + 1).split("/"));
  return path;
}

const PATH_FIELDS = ["binaryJar", "sourcesJar", "sourceDir"] as const;

/** Portable form: checkout-specific paths and module namespaces become tokens. */
function toPortable(m: Manifest, projectRoot: string): Manifest {
  const spellings = rootSpellings(projectRoot);
  const nsPrefix = `module:${moduleNamespace(projectRoot)}:`;
  return {
    ...m,
    artifacts: m.artifacts.map((artifact) => {
      const out: DependencyArtifact = { ...artifact };
      if (out.coordinates.startsWith(nsPrefix)) {
        out.coordinates = `module:${NS_TOKEN}:${out.coordinates.slice(nsPrefix.length)}`;
      }
      for (const field of PATH_FIELDS) {
        const value = out[field];
        if (value !== undefined) out[field] = tokenizePath(value, spellings);
      }
      return out;
    }),
  };
}

/** The portable form rebased onto `projectRoot`. */
function fromPortable(m: Manifest, projectRoot: string): Manifest {
  const root = resolve(projectRoot);
  const nsPrefix = `module:${NS_TOKEN}:`;
  const ns = moduleNamespace(projectRoot);
  return {
    ...m,
    artifacts: m.artifacts.map((artifact) => {
      const out: DependencyArtifact = { ...artifact };
      if (out.coordinates.startsWith(nsPrefix)) {
        out.coordinates = `module:${ns}:${out.coordinates.slice(nsPrefix.length)}`;
      }
      for (const field of PATH_FIELDS) {
        const value = out[field];
        if (value !== undefined) out[field] = detokenizePath(value, root);
      }
      return out;
    }),
  };
}

/** Parse one stored manifest file; missing, corrupt, or wrong-shaped → null. */
function loadFile(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
    if (
      parsed?.version !== MANIFEST_VERSION ||
      typeof parsed.resolvedAt !== "string" ||
      typeof parsed.dependencySetHash !== "string" ||
      !Array.isArray(parsed.artifacts) ||
      !validIncomplete(parsed.incomplete)
    ) {
      return null;
    }
    return parsed as Manifest;
  } catch {
    return null;
  }
}

/** An `incomplete` field is optional but, when present, must be a well-formed degraded-entry list. */
function validIncomplete(incomplete: Manifest["incomplete"]): boolean {
  if (incomplete === undefined) return true;
  return (
    Array.isArray(incomplete) &&
    incomplete.every(
      (entry) =>
        (entry?.from === "gradle" || entry?.from === "maven") && typeof entry.reason === "string",
    )
  );
}

/** Refresh an entry's mtime (the prune clock) when it is older than a day. */
function touch(path: string): void {
  try {
    const now = Date.now();
    if (now - statSync(path).mtimeMs > TOUCH_AFTER_MS) utimesSync(path, now / 1000, now / 1000);
  } catch {
    // best effort: a missed touch only ages an entry toward pruning
  }
}

function readPointer(projectRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(pointerPath(projectRoot), "utf8")) as { key?: unknown };
    return typeof parsed.key === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.key) ? parsed.key : null;
  } catch {
    return null;
  }
}

/**
 * The stored file `projectRoot` last wrote (its pointer's target), or null
 * when it never wrote one. Diagnostics and tests; queries use readManifest.
 */
export function lastManifestPath(projectRoot: string): string | null {
  const key = readPointer(projectRoot);
  return key === null ? null : manifestPath(key);
}

/**
 * The manifest serving `projectRoot`: the entry under the current key (a
 * fresh hit — possibly written by another checkout), else the entry this
 * root last wrote (stale by key, served flagged), else null. Missing or
 * corrupt files read as absent, never a throw.
 */
export async function readManifest(
  projectRoot: string,
  strategy: BuildToolStrategy,
  m2Root: string,
): Promise<Manifest | null> {
  const key = await computeDependencySetHash(projectRoot, strategy, m2Root);
  const current = loadFile(manifestPath(key));
  if (current !== null) {
    touch(manifestPath(key));
    return fromPortable(current, projectRoot);
  }
  const last = readPointer(projectRoot);
  if (last === null || last === key) return null;
  const previous = loadFile(manifestPath(last));
  return previous === null ? null : fromPortable(previous, projectRoot);
}

/** Write `path` via tmp + rename so readers (other processes too) only see whole files. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Store `m` under its own key (`m.dependencySetHash`) in portable form and
 * point `projectRoot` at it; then prune entries unused for 30 days.
 */
export async function writeManifest(projectRoot: string, m: Manifest): Promise<void> {
  const path = manifestPath(m.dependencySetHash);
  mkdirSync(join(cacheDir(), "manifests"), { recursive: true });
  mkdirSync(join(cacheDir(), "roots"), { recursive: true });
  atomicWrite(path, JSON.stringify(toPortable(m, projectRoot)));
  atomicWrite(
    pointerPath(projectRoot),
    JSON.stringify({ root: resolve(projectRoot), key: m.dependencySetHash }),
  );
  prune();
}

/** Drop manifests and pointers untouched for PRUNE_AFTER_MS. Best effort. */
function prune(): void {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const sub of ["manifests", "roots"]) {
    const dir = join(cacheDir(), sub);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // raced with another process's prune or write: nothing to do
      }
    }
  }
}

/**
 * Stale when the build files' key moved (the served manifest is the root's
 * previous entry) or any artifact's recorded backing (binary/sources jar,
 * source dir) disappeared — either way the manifest no longer reflects what
 * a resolve would produce today. Source TREE contents are deliberately not
 * fingerprinted: the manifest promises which artifacts back the project,
 * not that their contents have not been rebuilt since.
 */
export async function isStale(
  projectRoot: string,
  m: Manifest,
  strategy: BuildToolStrategy,
  m2Root: string,
): Promise<boolean> {
  if ((await computeDependencySetHash(projectRoot, strategy, m2Root)) !== m.dependencySetHash) {
    return true;
  }
  for (const artifact of m.artifacts) {
    if (
      [artifact.binaryJar, artifact.sourcesJar, artifact.sourceDir].some(
        (path) => path !== undefined && !existsSync(path),
      )
    ) {
      return true;
    }
  }
  return false;
}
