/**
 * The miss protocol after Task 8: suggest-or-negative, nothing between.
 *
 * The manifest is the only state — ensureReady already re-resolves on
 * staleness, and there is no index to be missing — so a lookup miss either
 * finds fuzzy/simple-name candidates for what was probably meant or reports
 * the searched set honestly and stops. The JDK-namespace and staleness
 * re-resolve steps are gone; these tests pin that they stay gone.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMiss, type MissResult } from "../../src/core/miss.js";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { LookupMissError } from "../../src/core/query/outline.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const DEMO_SOURCES_JAR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "jars",
  "demo-lib-1.0.0-sources.jar",
);

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-miss-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Open a context over a manifest written BEFORE construction (fresh, served without resolving). */
async function contextWith(artifacts: DependencyArtifact[]): Promise<QueryContext> {
  const projectRoot = freshRoot();
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  await writeManifest(projectRoot, {
    version: 1,
    resolvedAt: "",
    dependencySetHash: await computeDependencySetHash(projectRoot),
    artifacts,
  });
  return openContext(projectRoot, { cacheDir: freshRoot(), onProgress: () => {} });
}

const DEMO_SOURCES: DependencyArtifact = {
  coordinates: "com.example:demo-lib:1.0.0",
  kind: "external",
  sourcesJar: DEMO_SOURCES_JAR,
};

describe("handleMiss step 1: fuzzy candidates", () => {
  it("a class-lookup miss with findClass hits returns them via fuzzy-candidates", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    // "Dmo" is a subsequence of Demo: the fuzzy tier finds what was meant
    const result: MissResult = await handleMiss(ctx, new LookupMissError("com.example.Dmo"));
    expect(result).toMatchObject({ found: true, via: "fuzzy-candidates" });
    if (!result.found || result.via !== "fuzzy-candidates") throw new Error("unreachable");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.Demo");
  });
});

describe("handleMiss negative", () => {
  it("a miss with no candidates lists the searched artifacts and the planned-extension note", async () => {
    const ctx = await contextWith([
      DEMO_SOURCES,
      { coordinates: "com.example:nosources-lib:1.0.0", kind: "external" },
    ]);
    const result = await handleMiss(ctx, new LookupMissError("com.example.Nowhere"));
    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.via).toBe("negative");
    expect(result.searchedArtifacts).toContain("com.example:demo-lib:1.0.0");
    expect(result.searchedArtifacts).toContain("com.example:nosources-lib:1.0.0");
    expect(result.note).toBe(
      "not found in resolved artifacts; remote artifact search is a planned extension",
    );
  });

  it("a query-shaped miss (no fqn) skips the suggestion step and reports negative", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await handleMiss(ctx, { query: "some-resource-glob" });
    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.via).toBe("negative");
    expect(result.searchedArtifacts).toEqual(["com.example:demo-lib:1.0.0"]);
  });

  it("a JDK-namespace miss goes straight to negative (the JDK step is gone)", async () => {
    // v1 indexed the JDK pseudo-artifact and retried; the manifest is the only
    // state now, so java.* names miss exactly like any other fqn
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await handleMiss(ctx, new LookupMissError("java.util.FakeMiss"));
    expect(result).toMatchObject({ found: false, via: "negative" });
  });
});
