/**
 * Warning-channel lifecycle: the degraded[] arrays every tool returns are
 * only honest if (a) they describe the LAST bootstrap rather than the
 * accumulation of every bootstrap this process ever ran, and (b) a fresh
 * process serving an existing manifest still surfaces the per-artifact
 * warnings indexing persisted into it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_SOURCES_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0-sources.jar");

const roots: string[] = [];

function freshProject(): { projectRoot: string; cacheDir: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-warnchan-project-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "jarpeek-warnchan-cache-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  roots.push(projectRoot, cacheDir);
  return { projectRoot, cacheDir };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("warning channel lifecycle", () => {
  it("a successful bootstrap clears the previous bootstrap's warnings", async () => {
    const { projectRoot, cacheDir } = freshProject();
    const goodArtifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:demo-lib:1.0.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
        provenance: "source",
        warnings: [],
      },
    ];
    let impl: () => Promise<{ ok: boolean; artifacts: DependencyArtifact[]; reason?: string }> =
      async () => ({ ok: false, artifacts: [], reason: "network down" });
    const ctx = openContext(projectRoot, {
      resolvers: {
        gradle: async () => impl(),
        cacheScan: async () => ({ artifacts: [], warnings: [] }),
        includeJdk: false,
      },
      cacheDir,
      onProgress: () => {},
    });

    await ctx.ensureReady();
    const afterFailure = await ctx.bootstrapWarnings();
    expect(afterFailure.some((w) => w.startsWith("gradle: network down"))).toBe(true);
    expect(afterFailure).toContain("degraded-to-cache-scan");

    // the build heals; the build file moved, so the next query re-bootstraps
    impl = async () => ({ ok: true, artifacts: goodArtifacts });
    const gradle = join(projectRoot, "build.gradle");
    writeFileSync(gradle, "plugins { id 'java' }\n// healed\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(gradle, future, future);

    await ctx.ensureReady();
    const afterSuccess = await ctx.bootstrapWarnings();
    expect(afterSuccess.some((w) => w.includes("network down"))).toBe(false);
    expect(afterSuccess).not.toContain("degraded-to-cache-scan");
  });

  it("a fresh process serving an existing manifest surfaces its persisted artifact warnings", async () => {
    const { projectRoot, cacheDir } = freshProject();
    const artifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:warny:1.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
        provenance: "source",
        warnings: ["cache-scan ambiguity: warny matched two layouts"],
      },
    ];
    let calls = 0;
    const first = openContext(projectRoot, {
      resolvers: {
        gradle: async () => {
          calls++;
          return { ok: true, artifacts };
        },
        includeJdk: false,
      },
      cacheDir,
      onProgress: () => {},
    });
    await first.ensureReady();
    expect(calls).toBe(1);
    // the manifest persisted the artifact warning
    expect((await first.manifest())!.artifacts[0]!.warnings).toContain(
      "cache-scan ambiguity: warny matched two layouts",
    );

    // a FRESH process (the long-lived MCP server restarted) serves the same
    // manifest without bootstrapping — the warning must still surface
    const second = openContext(projectRoot, {
      resolvers: {
        gradle: async () => {
          calls++;
          return { ok: true, artifacts };
        },
        includeJdk: false,
      },
      cacheDir,
      onProgress: () => {},
    });
    await second.ensureReady();
    expect(calls).toBe(1); // served fresh: no resolver ran
    expect(await second.bootstrapWarnings()).toContain("cache-scan ambiguity: warny matched two layouts");
  });
});

describe("zero-artifact manifest scoping", () => {
  it("scopes to empty: store-era foreign shards are no hits, and outline never serves them", async () => {
    const { projectRoot, cacheDir } = freshProject();
    const ctx: QueryContext = openContext(projectRoot, { cacheDir, onProgress: () => {} });

    // a foreign shard lands in the user-global store (another project's
    // artifact, written directly) — find_class still reads the store until
    // Task 8, but the store is scoped by the manifest
    await ctx.store.writeArtifact(
      {
        coordinates: "com.foreign:lib:1",
        kind: "external",
        provenance: "signature",
        warnings: [],
      },
      [
        {
          fqn: "com.foreign.Spy",
          file: "com/foreign/Spy.class",
          selector: "Spy",
          kind: "class",
          visibility: "public",
          static: false,
          deprecated: false,
          signature: "public class Spy",
        },
      ],
    );

    // the manifest EXISTS and declares zero artifacts (a resolved-empty set)
    await writeManifest(projectRoot, {
      version: 1,
      resolvedAt: new Date().toISOString(),
      dependencySetHash: await computeDependencySetHash(projectRoot),
      artifacts: [],
    });

    const { findClass } = await import("../../src/core/query/find-class.js");
    const { outline, LookupMissError } = await import("../../src/core/query/outline.js");

    const found = await findClass(ctx, "Spy");
    expect(found.hits).toEqual([]);

    // the listing-backed lookup has no fallback tier: with an empty manifest
    // there is nothing to locate, so the miss protocol applies
    const err = await outline(ctx, "com.foreign.Spy").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupMissError);
  });
});
