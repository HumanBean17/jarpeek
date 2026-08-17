/**
 * CacheScan resolver: the build-tool-free fallback.
 *
 * When neither Gradle nor Maven can be run (missing, offline, or failed), the
 * local machine's dependency caches still say what the developer has been
 * building against. This module walks the Maven local repository and the
 * Gradle modules-2 cache, pairing binary and `-sources` jars by their path
 * layouts. It is a heuristic: caches hold more than any one project resolves,
 * versions collide, and walks must be bounded — every one of those degrades
 * into a warning, never a throw.
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { DependencyArtifact } from "../core/types.js";

export interface ScanCachesOptions {
  m2Dir?: string;
  gradleDir?: string;
  maxEntries?: number;
}

export interface ScanCachesResult {
  artifacts: DependencyArtifact[];
  warnings: string[];
}

const DEFAULT_MAX_ENTRIES = 20_000;

/** Files that never yield artifacts regardless of layout match. */
const SKIP_SUFFIXES = ["-javadoc.jar", ".sha1", ".lastUpdated", ".pom"] as const;
const SKIP_PREFIXES = ["maven-metadata.xml", "."] as const;

function isSkipped(name: string): boolean {
  if (!name.endsWith(".jar")) return true;
  return SKIP_SUFFIXES.some((s) => name.endsWith(s)) || SKIP_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Semver-ish ordering: split on `.` and `-`; when both segments parse as
 * integers compare numerically, otherwise lexicographically; the longer
 * array wins a prefix tie (1.10.0 > 1.10, 2.0.0 > 2.0.0.RC1).
 */
export function compareVersions(a: string, b: string): number {
  const sa = a.split(/[.-]/);
  const sb = b.split(/[.-]/);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const nx = Number(x);
    const ny = Number(y);
    const bothNumeric = x !== "" && y !== "" && Number.isInteger(nx) && Number.isInteger(ny);
    const c = bothNumeric ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return 0;
}

/** One discovered jar: layout coordinates plus the file it came from. */
interface Found {
  group: string;
  artifact: string;
  version: string;
  sources: boolean;
  path: string;
}

/** Normalized `/`-separated path of `p`, relative to `root`. */
function relParts(root: string, p: string): string[] {
  return p.slice(root.length).split(sep).filter((s) => s.length > 0);
}

/**
 * m2 layout: `<group-path>/<artifact>/<version>/<artifact>-<version>.jar`
 * (optionally `-sources`); the group is variable-depth (`org/apache/kafka`
 * → `org.apache.kafka`), so only the last three segments are fixed.
 */
function matchM2(root: string, path: string, name: string): Found | null {
  const parts = relParts(root, path);
  if (parts.length < 3) return null;
  const file = parts[parts.length - 1];
  const version = parts[parts.length - 2];
  const artifact = parts[parts.length - 3];
  const sources = file.endsWith("-sources.jar");
  const stem = sources ? `${artifact}-${version}-sources.jar` : `${artifact}-${version}.jar`;
  if (file !== stem) return null;
  return { group: parts.slice(0, parts.length - 3).join("."), artifact, version, sources, path };
}

/**
 * Gradle modules-2 layout: `<group>/<artifact>/<version>/<hash>/<file>` —
 * same filename contract as m2, but under an opaque hash directory, and the
 * group arrives as a single dotted directory name. Binary and sources jars
 * may live under different hashes, so pairing happens later by coordinates.
 */
function matchGradle(root: string, path: string, name: string): Found | null {
  const parts = relParts(root, path);
  if (parts.length !== 5) return null;
  const [group, artifact, version, hash, file] = parts;
  if (!/^[0-9a-f]+$/i.test(hash)) return null;
  const sources = file.endsWith("-sources.jar");
  const stem = sources ? `${artifact}-${version}-sources.jar` : `${artifact}-${version}.jar`;
  if (file !== stem) return null;
  return { group, artifact, version, sources, path };
}

/** A coordinate's accumulated jars across both roots. */
interface Coordinate {
  group: string;
  artifact: string;
  version: string;
  binaryJar?: string;
  sourcesJar?: string;
}

interface WalkOutcome {
  found: Found[];
  /** Total files visited, matched or skipped — the budget's real spend. */
  visited: number;
  /** Set to the visit count when the budget ran out; undefined when completed. */
  truncatedAt?: number;
}

/**
 * Depth-first walk of `root` collecting layout matches, visiting at most
 * `maxEntries` files. The budget counts every file seen (matched or not), so
 * a cache stuffed with checksums and poms still terminates. Unreadable
 * directories are skipped silently: a cache scan is best-effort by design.
 */
function walk(root: string, maxEntries: number, match: (path: string, name: string) => Found | null): WalkOutcome {
  const found: Found[] = [];
  let visited = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // lexical order for both files and subdirs keeps walks deterministic
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      visited++;
      if (visited > maxEntries) return { found, visited, truncatedAt: visited };
      if (isSkipped(entry.name)) continue;
      const hit = match(path, entry.name);
      if (hit) found.push(hit);
    }
  }
  return { found, visited };
}

/**
 * Reduce per-layout finds to one entry per `g:a:v`, keeping one binary jar
 * and one sources jar. Within a coordinate the m2 jar (earlier root) wins
 * over the gradle one, which is how cross-root merging prefers m2.
 */
function collectCoordinates(finds: Found[]): Map<string, Coordinate> {
  const byCoords = new Map<string, Coordinate>();
  for (const f of finds) {
    const key = `${f.group}:${f.artifact}:${f.version}`;
    let coord = byCoords.get(key);
    if (coord === undefined) {
      coord = { group: f.group, artifact: f.artifact, version: f.version };
      byCoords.set(key, coord);
    }
    if (f.sources) {
      coord.sourcesJar ??= f.path;
    } else if (coord.binaryJar === undefined) {
      coord.binaryJar = f.path;
    }
  }
  return byCoords;
}

/**
 * Scan the m2 repository and the Gradle modules-2 cache for dependency jars,
 * pairing sources and deduplicating versions. Both roots are walked with a
 * shared budget of `maxEntries` files; m2 wins when the same coordinate
 * appears in both. Version ambiguity produces a per-artifact warning,
 * truncation a global one; a missing root is simply an empty walk.
 */
export async function scanCaches(opts: ScanCachesOptions = {}): Promise<ScanCachesResult> {
  const m2Dir = opts.m2Dir ?? join(homedir(), ".m2", "repository");
  const gradleDir = opts.gradleDir ?? join(homedir(), ".gradle", "caches", "modules-2", "files-2.1");
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // m2 first: its finds are inserted first, so collectCoordinates keeps them.
  // The budget is spent on files visited (matched or skipped), not matched.
  const m2Walk = walk(m2Dir, maxEntries, (path, name) => matchM2(m2Dir, path, name));
  let truncatedAt: number | undefined = m2Walk.truncatedAt;
  let gradleFound: Found[] = [];
  if (truncatedAt === undefined) {
    // the gradle walk gets whatever budget the m2 walk actually spent
    const gradleWalk = walk(gradleDir, Math.max(maxEntries - m2Walk.visited, 0), (path, name) =>
      matchGradle(gradleDir, path, name),
    );
    gradleFound = gradleWalk.found;
    truncatedAt =
      gradleWalk.truncatedAt === undefined ? undefined : m2Walk.visited + gradleWalk.truncatedAt;
  }

  const byCoords = collectCoordinates([...m2Walk.found, ...gradleFound]);

  // group by g:a, keep the highest version, warn about the rest
  const byGA = new Map<string, Coordinate[]>();
  for (const coord of byCoords.values()) {
    const key = `${coord.group}:${coord.artifact}`;
    (byGA.get(key) ?? byGA.set(key, []).get(key)!).push(coord);
  }

  const artifacts: DependencyArtifact[] = [];
  for (const versions of byGA.values()) {
    versions.sort((a, b) => compareVersions(a.version, b.version));
    const kept = versions[versions.length - 1];
    const also = versions.slice(0, -1).map((v) => v.version);
    const warnings =
      also.length > 0 ? [`multiple-versions:${kept.group}:${kept.artifact} (kept ${kept.version}, also saw ${also.join(",")})`] : [];
    artifacts.push({
      coordinates: `${kept.group}:${kept.artifact}:${kept.version}`,
      kind: "cache-scan",
      ...(kept.binaryJar !== undefined ? { binaryJar: kept.binaryJar } : {}),
      ...(kept.sourcesJar !== undefined ? { sourcesJar: kept.sourcesJar } : {}),
      provenance: kept.sourcesJar !== undefined ? "source" : "signature",
      warnings,
    });
  }

  // stable output order: coordinates sorted
  artifacts.sort((a, b) => (a.coordinates < b.coordinates ? -1 : a.coordinates > b.coordinates ? 1 : 0));

  const warnings: string[] = [];
  if (truncatedAt !== undefined) warnings.push(`cache-scan-truncated:${truncatedAt}`);

  return { artifacts, warnings };
}
