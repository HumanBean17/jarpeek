/**
 * where: the paths-printer — an artifact's recorded on-disk locations with
 * an existence flag each. Nothing is written (the eager unpack-for-Grep died
 * with the index), so these suites assert exactly that: `.jarpeek` still
 * holds only the manifest and the result lists what the manifest recorded,
 * existing or not. The manifest is written directly per suite
 * (fixture-manifest world: `writeManifest` with a matching
 * `dependencySetHash` so `isStale` is false and `ensureReady` never resolves).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { where } from "../../src/core/query/where.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const JARS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "jars");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

const MISSING = "artifact files missing on disk; run resolve";

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-where-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/**
 * A context over a manifest written BEFORE construction (fresh, non-stale).
 * The resolvers are stubbed to fail-and-degrade: the vanished-path suites
 * make their manifests stale on purpose, and `where` then bootstraps — with
 * the real cascade that means a REAL gradle/mvn run whose duration depends
 * on the host toolchain (a cold Gradle daemon on a windows runner blows the
 * vitest timeout). The stub keeps the bootstrap deterministic: degrade to
 * cache-scan instantly, serve the stale manifest — the behavior under test.
 */
async function contextWith(artifacts: DependencyArtifact[]): Promise<QueryContext> {
  const root = freshRoot();
  writeFileSync(join(root, "build.gradle"), "plugins { id 'java' }\n");
  // context first: the manifest must hash under the same primary m2 root
  // the context's convergence will check staleness with
  const ctx = openContext(root, {
    onNotice: () => {},
    resolvers: {
      gradle: async () => ({ ok: false, artifacts: [], reason: "no-wrapper-no-gradle" }),
      maven: async () => ({ ok: false, artifacts: [], reason: "no-classpath" }),
      cacheScan: async () => ({ artifacts: [], warnings: [] }),
      includeJdk: false,
    },
  });
  await writeManifest(root, {
    version: 2,
    resolvedAt: "2026-08-17T00:00:00.000Z",
    dependencySetHash: await computeDependencySetHash(root, "auto", ctx.roots.m2[0].path),
    artifacts,
  });
  return ctx;
}

describe("where lists recorded paths", () => {
  let ctx: QueryContext;

  beforeAll(async () => {
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

  it("both-jars artifact lists sourcesJar and binaryJar, each exists", async () => {
    const result = await where(ctx, "demo-lib");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.paths).toEqual([
      { role: "sourcesJar", path: DEMO_SOURCES_JAR, exists: true },
      { role: "binaryJar", path: DEMO_JAR, exists: true },
    ]);
    expect(result.stale).toBeUndefined();
    expect(result.degraded).toEqual([]);
  });

  it("binary-only artifact lists its single binaryJar row", async () => {
    const result = await where(ctx, "nosources-lib");
    expect(result.paths).toEqual([{ role: "binaryJar", path: NOSOURCES_JAR, exists: true }]);
  });

  it("writes nothing — .jarpeek still holds only the manifest", async () => {
    await where(ctx, "demo-lib");
    expect(readdirSync(join(ctx.projectRoot, ".jarpeek"))).toEqual(["manifest.json"]);
  });

  it("unknown artifact query throws (fatal, as today)", async () => {
    await expect(where(ctx, "no-such-artifact")).rejects.toThrow(/unknown artifact/);
  });
});

describe("where existence flags", () => {
  it("a vanished binaryJar row reports exists false while the sources row stays true", async () => {
    const dir = freshRoot();
    const jar = join(dir, "gone-lib-1.0.0.jar");
    writeFileSync(jar, "stub"); // exists at manifest time so the path is recorded
    const ctx = await contextWith([
      {
        coordinates: "com.example:gone-lib:1.0.0",
        kind: "external",
        binaryJar: jar,
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ]);
    rmSync(jar);
    const result = await where(ctx, "gone-lib");
    expect(result.paths).toEqual([
      { role: "sourcesJar", path: DEMO_SOURCES_JAR, exists: true },
      { role: "binaryJar", path: jar, exists: false },
    ]);
    // a vanished path also makes the manifest stale (isStale checks artifact
    // paths), so the stale-served warnings DO fire here — but the all-missing
    // hint must not, because the sources row still exists
    expect(result.stale).toBe(true);
    expect(result.degraded).not.toContain(MISSING);
  });

  it("all paths missing adds the resolve hint to degraded", async () => {
    const dir = freshRoot();
    const jar = join(dir, "all-gone.jar");
    const sources = join(dir, "all-gone-sources.jar");
    writeFileSync(jar, "stub");
    writeFileSync(sources, "stub");
    const ctx = await contextWith([
      {
        coordinates: "com.example:all-gone:1.0.0",
        kind: "external",
        binaryJar: jar,
        sourcesJar: sources,
      },
    ]);
    rmSync(jar);
    rmSync(sources);
    const result = await where(ctx, "all-gone");
    expect(result.paths.every((p) => p.exists === false)).toBe(true);
    expect(result.degraded).toContain(MISSING);
  });

  it("a sourceDir artifact lists its directory row", async () => {
    const dir = freshRoot();
    const src = join(dir, "src", "main", "java");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "A.java"), "class A {}\n");
    const ctx = await contextWith([
      { coordinates: "com.example:module:1.0", kind: "module", sourceDir: src },
    ]);
    const result = await where(ctx, "module");
    expect(result.paths).toEqual([{ role: "sourceDir", path: src, exists: true }]);
  });

  it("sourceDir outranks jars in the row order (sources first, as recorded)", async () => {
    // a module artifact may carry both a sourceDir and a binaryJar; the
    // sources-first ordering matches the provenance ladder's preference
    const dir = freshRoot();
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "A.java"), "class A {}\n");
    const ctx = await contextWith([
      {
        coordinates: "com.example:mixed:1.0",
        kind: "module",
        sourceDir: src,
        binaryJar: NOSOURCES_JAR,
      },
    ]);
    const result = await where(ctx, "mixed");
    expect(result.paths.map((p) => p.role)).toEqual(["sourceDir", "binaryJar"]);
  });
});
