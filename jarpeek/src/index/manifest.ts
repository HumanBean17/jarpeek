import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";

/** Layout version of `.jarpeek/manifest.json`; bumps force a full re-resolve. */
const MANIFEST_VERSION = 1;

export interface Manifest {
  version: 1;
  resolvedAt: string;
  dependencySetHash: string;
  artifacts: DependencyArtifact[];
}

/**
 * Build files whose (size, mtime) fingerprint the resolved dependency set:
 * Gradle/Maven top-level files plus `pom.xml` in immediate subdirectories
 * (Maven multi-module reactors). Depth is capped at 2 total.
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
      const stats = statSync(join(projectRoot, relpath));
      return `${relpath}\t${stats.size}\t${stats.mtimeMs}`;
    })
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Stale when the build files' fingerprint moved, or any artifact's on-disk
 * source (binary/sources jar, source or classes dir) disappeared. Both mean
 * the index no longer reflects what a resolve would produce today.
 */
export async function isStale(projectRoot: string, m: Manifest): Promise<boolean> {
  if ((await computeDependencySetHash(projectRoot)) !== m.dependencySetHash) {
    return true;
  }
  return m.artifacts.some((artifact) =>
    [artifact.binaryJar, artifact.sourcesJar, artifact.sourceDir, artifact.classesDir].some(
      (path) => path !== undefined && !existsSync(path),
    ),
  );
}

function manifestPath(projectRoot: string): string {
  return join(projectRoot, ".jarpeek", "manifest.json");
}

/** Existing build-file relpaths: the fixed root set plus `pom.xml` in each immediate subdirectory. */
function candidateFiles(projectRoot: string): string[] {
  const candidates = new Set<string>(ROOT_BUILD_FILES);
  for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== ".jarpeek") {
      candidates.add(entry.name + "/pom.xml");
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
