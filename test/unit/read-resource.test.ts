/**
 * readResource's provenance: computed from the artifact's backings, not the
 * stored per-artifact field — an artifact with a sources jar (or a source
 * dir) answers `source`, a binary-only one answers `signature`. The manifest
 * is written directly per suite (fixture-manifest world) with the stored
 * `provenance` field deliberately ABSENT so a stored-field implementation
 * fails the `source` case.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { readResource } from "../../src/core/query/read-resource.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const JARS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "jars");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-resource-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A context over a manifest written BEFORE construction (fresh, non-stale). */
async function contextWith(artifacts: DependencyArtifact[]): Promise<QueryContext> {
  const root = freshRoot();
  writeFileSync(join(root, "build.gradle"), "plugins { id 'java' }\n");
  await writeManifest(root, {
    version: 2,
    resolvedAt: "2026-08-17T00:00:00.000Z",
    dependencySetHash: await computeDependencySetHash(root),
    artifacts,
  });
  return openContext(root, { onNotice: () => {} });
}

describe("readResource provenance is computed", () => {
  let ctx: QueryContext;

  beforeAll(async () => {
    // no stored provenance on either artifact — the field cannot answer
    ctx = await contextWith([
      {
        coordinates: "com.example:demo-lib:1.0.0",
        kind: "external",
        binaryJar: DEMO_JAR,
        sourcesJar: DEMO_SOURCES_JAR,
      },
      { coordinates: "com.example:nosources-lib:1.0.0", kind: "external", binaryJar: NOSOURCES_JAR },
    ]);
  });

  it("sources-bearing artifact answers source", async () => {
    const result = await readResource(ctx, "demo-lib", "config/*");
    expect(result.provenance).toBe("source");
    expect(result.entries[0]!.content).toBe("key=value");
  });

  it("binary-only artifact answers signature", async () => {
    const result = await readResource(ctx, "nosources-lib", "**/*.class");
    expect(result.provenance).toBe("signature");
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it("a sourceDir-bearing artifact answers source (module case)", async () => {
    // readResource reads the jar (binaryJar ?? sourcesJar); the provenance
    // follows the backings — a recorded sourceDir means real source exists
    const result = await readResource(ctx, "demo-lib", "config/*");
    expect(result.provenance).toBe("source");
    // the module variant: binaryJar for reading, sourceDir for provenance
    const dir = freshRoot();
    const modCtx = await contextWith([
      {
        coordinates: "com.example:module:1.0",
        kind: "module",
        binaryJar: DEMO_JAR,
        sourceDir: dir,
      },
    ]);
    const mod = await readResource(modCtx, "module", "config/*");
    expect(mod.provenance).toBe("source");
  });
});
