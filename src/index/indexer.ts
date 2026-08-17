/**
 * Indexer orchestration: resolved artifacts in, declaration records out.
 *
 * Each artifact is indexed from its best available source — sourceDir,
 * sourcesJar, binaryJar, classesDir, in that order; the first field whose
 * path exists wins. Source branches parse with the Java/Kotlin lexers and
 * keep line ranges; binary branches read `.class` entries with the class-file
 * reader and carry signatures only. Degradation is always per entry: one
 * unreadable zip member or corrupt class file becomes a warning and the walk
 * continues — a bad artifact never aborts the run. After every artifact, the
 * project manifest is written with the final provenance and warnings.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Declaration, DependencyArtifact, Provenance } from "../core/types.js";
import {
  isClassEntry,
  recordsFromSourceText,
  recordsFromClassBytes,
} from "../parse/records.js";
import { listZipEntries, readTextEntry, readZipEntry } from "../parse/zip.js";
import { ensureCacheDir } from "../util/cache-dir.js";
import { IndexStore } from "./store.js";
import { computeDependencySetHash, computeSourceDirSignature, writeManifest } from "./manifest.js";
import { isSourceEntry, walkFiles } from "./walk.js";

export interface IndexerOptions {
  store?: IndexStore;
  onProgress?: (msg: string) => void;
}

export interface IndexResult {
  indexed: string[];
  skipped: Array<{ coordinates: string; reason: string }>;
  warnings: string[];
  durationMs: number;
}

/** What one source branch produced for one artifact. */
interface BranchResult {
  records: Declaration[];
  warnings: string[];
  /** Files handed to a parser; surfaced in the progress line. */
  files: number;
  provenance: Provenance;
}

/** A sources jar: parse every .java/.kt entry, fqn from parsed packages. */
async function indexSourcesJar(jarPath: string): Promise<BranchResult> {
  const records: Declaration[] = [];
  const warnings: string[] = [];
  let files = 0;
  let entries;
  try {
    entries = await listZipEntries(jarPath);
  } catch (e) {
    // the whole archive is unreadable: one warning, zero records, no throw
    return { records, warnings: [`failed to index ${basename(jarPath)}: ${(e as Error).message}`], files, provenance: "source" };
  }
  for (const entry of entries) {
    if (entry.isDirectory || !isSourceEntry(entry.name)) continue;
    files++;
    let text: string;
    try {
      text = await readTextEntry(jarPath, entry);
    } catch (e) {
      warnings.push(`failed to index ${entry.name}: ${(e as Error).message}`);
      continue;
    }
    const parsed = recordsFromSourceText(text, entry.name);
    records.push(...parsed.records);
    for (const diagnostic of parsed.diagnostics) {
      warnings.push(`failed to index ${entry.name}: ${diagnostic}`);
    }
  }
  return { records, warnings, files, provenance: "source" };
}

/** A binary jar: read every .class entry with the class-file reader. */
async function indexBinaryJar(jarPath: string): Promise<BranchResult> {
  const records: Declaration[] = [];
  const warnings: string[] = [];
  let files = 0;
  let entries;
  try {
    entries = await listZipEntries(jarPath);
  } catch (e) {
    return { records, warnings: [`failed to index ${basename(jarPath)}: ${(e as Error).message}`], files, provenance: "signature" };
  }
  for (const entry of entries) {
    if (entry.isDirectory || !isClassEntry(entry.name)) continue;
    files++;
    try {
      const parsed = recordsFromClassBytes(await readZipEntry(jarPath, entry), entry.name, entry.name);
      records.push(...parsed.records);
      if (parsed.warning !== undefined) warnings.push(parsed.warning);
    } catch (e) {
      warnings.push(`failed to index ${entry.name}: ${(e as Error).message}`);
    }
  }
  return { records, warnings, files, provenance: "signature" };
}

/** A classesDir (e.g. JDK jimage output): walk .class files like a binary jar. */
function indexClassesDir(classesDir: string): BranchResult {
  const records: Declaration[] = [];
  const warnings: string[] = [];
  const files = walkFiles(classesDir, (name) => name.endsWith(".class"), false, warnings);
  for (const relPath of files) {
    if (!isClassEntry(relPath)) continue;
    try {
      const parsed = recordsFromClassBytes(readFileSync(join(classesDir, relPath)), relPath, relPath);
      records.push(...parsed.records);
      if (parsed.warning !== undefined) warnings.push(parsed.warning);
    } catch (e) {
      warnings.push(`failed to index ${relPath}: ${(e as Error).message}`);
    }
  }
  return { records, warnings, files: files.length, provenance: "signature" };
}

/** A sourceDir: parse .java/.kt files, file paths relative to the project root. */
function indexSourceDir(sourceDir: string, projectRoot: string): BranchResult {
  const records: Declaration[] = [];
  const warnings: string[] = [];
  const files = walkFiles(sourceDir, isSourceEntry, true, warnings);
  for (const relToDir of files) {
    const file = relative(projectRoot, join(sourceDir, relToDir)).replaceAll("\\", "/");
    try {
      const parsed = recordsFromSourceText(readFileSync(join(sourceDir, relToDir), "utf8"), file);
      records.push(...parsed.records);
      for (const diagnostic of parsed.diagnostics) {
        warnings.push(`failed to index ${file}: ${diagnostic}`);
      }
    } catch (e) {
      warnings.push(`failed to index ${file}: ${(e as Error).message}`);
    }
  }
  return { records, warnings, files: files.length, provenance: "source" };
}

/**
 * Index `artifacts` into `store` (default: the resolved jarpeek cache) and
 * write the project manifest. Returns per-run coordinates, skips, warnings,
 * and wall-clock duration; never throws on a bad artifact.
 */
export async function indexArtifacts(
  projectRoot: string,
  artifacts: DependencyArtifact[],
  opts: IndexerOptions = {},
): Promise<IndexResult> {
  const store = opts.store ?? new IndexStore(ensureCacheDir());
  const progress = opts.onProgress ?? (() => {});
  const startedAt = Date.now();

  const indexed: string[] = [];
  const skipped: Array<{ coordinates: string; reason: string }> = [];
  const warnings: string[] = [];
  const manifestArtifacts: DependencyArtifact[] = [];

  for (const artifact of artifacts) {
    // first source whose path exists wins; provenance follows the branch
    let result: BranchResult | undefined;
    if (artifact.sourceDir && existsSync(artifact.sourceDir)) {
      result = indexSourceDir(artifact.sourceDir, projectRoot);
    } else if (artifact.sourcesJar && existsSync(artifact.sourcesJar)) {
      result = await indexSourcesJar(artifact.sourcesJar);
    } else if (artifact.binaryJar && existsSync(artifact.binaryJar)) {
      result = await indexBinaryJar(artifact.binaryJar);
    } else if (artifact.classesDir && existsSync(artifact.classesDir)) {
      result = indexClassesDir(artifact.classesDir);
    }

    if (result === undefined) {
      skipped.push({ coordinates: artifact.coordinates, reason: "no jar or source dir" });
      progress(`skipping ${artifact.coordinates} (no jar or source dir)`);
      continue;
    }

    warnings.push(...result.warnings);
    // fingerprint the module tree at index time so a later sibling-file edit
    // flips staleness (module line ranges describe files that can change
    // without any build file moving); null = tree unwalkable, nothing recorded
    const sourceSig =
      artifact.sourceDir !== undefined && existsSync(artifact.sourceDir)
        ? await computeSourceDirSignature(artifact.sourceDir)
        : undefined;
    const finalArtifact: DependencyArtifact = {
      ...artifact,
      provenance: result.provenance,
      warnings: [...artifact.warnings, ...result.warnings],
      ...(sourceSig !== null && sourceSig !== undefined ? { sourceSig } : {}),
    };
    // always written, even with zero records: an empty shard replaces the
    // previous one instead of leaving stale records serving as fresh forever
    await store.writeArtifact(finalArtifact, result.records);
    indexed.push(artifact.coordinates);
    manifestArtifacts.push(finalArtifact);
    progress(`indexing ${artifact.coordinates} (${result.provenance}, ${result.files} files)`);
  }

  await writeManifest(projectRoot, {
    version: 1,
    resolvedAt: new Date().toISOString(),
    dependencySetHash: await computeDependencySetHash(projectRoot),
    artifacts: manifestArtifacts,
  });

  return { indexed, skipped, warnings, durationMs: Date.now() - startedAt };
}
