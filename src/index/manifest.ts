import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";

/** Layout version of `.jarpeek/manifest.json`; bumps force a full re-resolve. */
const MANIFEST_VERSION = 2;

export interface Manifest {
  version: 2;
  resolvedAt: string;
  dependencySetHash: string;
  artifacts: DependencyArtifact[];
}

/**
 * Build files whose (size, mtime) fingerprint the resolved dependency set:
 * Gradle/Maven top-level files plus the module build files (`pom.xml`,
 * `build.gradle[.kts]`) in immediate subdirectories — Maven reactors and
 * Gradle multi-module builds alike. Depth is capped at 2 total.
 */
const ROOT_BUILD_FILES = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml",
  "gradle.lockfile",
  "gradlew",
  "pom.xml",
  "mvnw",
] as const;

/**
 * Read `<projectRoot>/.jarpeek/manifest.json`; missing or corrupt → null.
 * A corrupt manifest means the index is unusable, which callers treat the
 * same as absent — never a throw.
 */
export async function readManifest(projectRoot: string): Promise<Manifest | null> {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
    if (
      parsed?.version !== MANIFEST_VERSION ||
      typeof parsed.resolvedAt !== "string" ||
      typeof parsed.dependencySetHash !== "string" ||
      !Array.isArray(parsed.artifacts)
    ) {
      return null;
    }
    return parsed as Manifest;
  } catch {
    return null;
  }
}

/** Write the manifest via tmp + rename so readers only see whole files. */
export async function writeManifest(projectRoot: string, m: Manifest): Promise<void> {
  const path = manifestPath(projectRoot);
  mkdirSync(join(projectRoot, ".jarpeek"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, path);
}

/**
 * sha256 hex over the sorted lines `<relpath>\t<size>\t<mtimeMs>` of the
 * build files that exist under `projectRoot`. An empty candidate set hashes
 * the empty string, so a project with no build files still has a stable
 * (and distinguishable-from-null) fingerprint.
 */
export async function computeDependencySetHash(projectRoot: string): Promise<string> {
  const lines = candidateFiles(projectRoot)
    .map((relpath) => {
      try {
        const stats = statSync(join(projectRoot, relpath));
        return `${relpath}\t${stats.size}\t${stats.mtimeMs}`;
      } catch {
        // vanished between the candidate check and now: fingerprint it as
        // changed so staleness errs toward re-resolving, never toward a throw
        return `${relpath}\t(vanished)`;
      }
    })
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Stale when the build files' fingerprint moved or any artifact's recorded
 * backing (binary/sources jar, source dir) disappeared — either way the
 * manifest no longer reflects what a resolve would produce today. Source
 * TREE contents are deliberately not fingerprinted: the manifest promises
 * which artifacts back the project, not that their contents have not been
 * rebuilt since.
 */
export async function isStale(projectRoot: string, m: Manifest): Promise<boolean> {
  if ((await computeDependencySetHash(projectRoot)) !== m.dependencySetHash) {
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

function manifestPath(projectRoot: string): string {
  return join(projectRoot, ".jarpeek", "manifest.json");
}

/**
 * Existing build-file relpaths: the fixed root set plus the module build
 * files (`pom.xml`, `build.gradle[.kts]`) in each immediate subdirectory.
 */
function candidateFiles(projectRoot: string): string[] {
  const candidates = new Set<string>(ROOT_BUILD_FILES);
  let entries: Array<Dirent<string>>;
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    // root unreadable or gone mid-check: the root set is all that remains,
    // and each stat below is individually guarded
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== ".jarpeek") {
      candidates.add(entry.name + "/pom.xml");
      candidates.add(entry.name + "/build.gradle");
      candidates.add(entry.name + "/build.gradle.kts");
    }
  }
  return [...candidates].filter((relpath) => {
    try {
      return statSync(join(projectRoot, relpath)).isFile();
    } catch {
      return false;
    }
  });
}
