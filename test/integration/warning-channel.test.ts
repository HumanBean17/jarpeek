/**
 * Warning-channel lifecycle: the degraded[] arrays every tool returns are
 * only honest if they describe the LAST bootstrap rather than the
 * accumulation of every bootstrap this process ever ran.
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

function freshProject(): { projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-warnchan-project-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  roots.push(projectRoot);
  return { projectRoot };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("warning channel lifecycle", () => {
  it("a successful bootstrap clears the previous bootstrap's warnings", async () => {
    const { projectRoot } = freshProject();
    const goodArtifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:demo-lib:1.0.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ];
    let impl: () => Promise<{ ok: boolean; artifacts: DependencyArtifact[]; reason?: string }> =
      async () => ({ ok: false, artifacts: [], reason: "network down" });
    let clock = 2_000_000;
    const ctx = openContext(projectRoot, {
      resolvers: {
        gradle: async () => impl(),
        cacheScan: async () => ({ artifacts: [], warnings: [] }),
        includeJdk: false,
      },
      now: () => clock,
    });

    await ctx.ensureReady();
    const afterFailure = await ctx.bootstrapWarnings();
    expect(afterFailure.some((w) => w.startsWith("gradle: network down"))).toBe(true);
    expect(afterFailure).toContain("resolution failed: degraded to cache-scan; run jarpeek resolve");

    // the build heals; the build file moved, so the next query re-bootstraps
    // — but only once the failed-bootstrap backoff window has passed
    impl = async () => ({ ok: true, artifacts: goodArtifacts });
    clock += 61_000;
    const gradle = join(projectRoot, "build.gradle");
    writeFileSync(gradle, "plugins { id 'java' }\n// healed\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(gradle, future, future);

    await ctx.ensureReady();
    const afterSuccess = await ctx.bootstrapWarnings();
    expect(afterSuccess.some((w) => w.includes("network down"))).toBe(false);
    expect(afterSuccess).not.toContain("degraded-to-cache-scan");
  });

  it("a fresh process serving an existing manifest carries no warnings", async () => {
    const { projectRoot } = freshProject();
    const artifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:warny:1.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
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
    });
    await first.ensureReady();
    expect(calls).toBe(1);
    expect(await first.bootstrapWarnings()).toEqual([]);

    // a FRESH process (the long-lived MCP server restarted) serves the same
    // manifest without bootstrapping and without warnings — nothing is
    // persisted per artifact anymore
    const second = openContext(projectRoot, {
      resolvers: {
        gradle: async () => {
          calls++;
          return { ok: true, artifacts };
        },
        includeJdk: false,
      },
    });
    await second.ensureReady();
    expect(calls).toBe(1); // served fresh: no resolver ran
    expect(await second.bootstrapWarnings()).toEqual([]);
  });
});

describe("cache-scan guard (manifest present)", () => {
  it("serves the manifest stale with the exact warning instead of adopting the scan", async () => {
    const { projectRoot } = freshProject();
    await writeManifest(projectRoot, {
      version: 2,
      resolvedAt: new Date().toISOString(),
      // a hash that no longer matches: the manifest is stale, so the next
      // query re-resolves — which is the only way the guard can engage
      dependencySetHash: "not-the-current-hash",
      artifacts: [
        {
          coordinates: "com.example:demo-lib:1.0.0",
          kind: "external",
          sourcesJar: DEMO_SOURCES_JAR,
        },
      ],
    });
    const ctx: QueryContext = openContext(projectRoot, {
      resolvers: {
        gradle: async () => ({ ok: false, artifacts: [], reason: "network down" }),
        maven: async () => ({ ok: false, artifacts: [], reason: "no pom" }),
        cacheScan: async () => ({
          artifacts: [
            {
              coordinates: "com.heuristic:guess:9",
              kind: "cache-scan",
              binaryJar: DEMO_SOURCES_JAR,
            },
          ],
          warnings: [],
        }),
        includeJdk: false,
      },
    });

    const result = await ctx.ensureReady();
    expect(result).toEqual({ bootstrapped: false, stale: true });
    expect(await ctx.bootstrapWarnings()).toContain(
      "stale index served (resolution degraded to cache scan)",
    );
    // the heuristic artifact set never reaches the manifest
    const manifest = await ctx.manifest();
    expect(manifest?.artifacts.map((a) => a.coordinates)).toEqual(["com.example:demo-lib:1.0.0"]);
  });
});

describe("zero-artifact manifest scoping", () => {
  it("scopes to empty: outline never serves foreign listings", async () => {
    const { projectRoot } = freshProject();
    const ctx: QueryContext = openContext(projectRoot);

    // the manifest EXISTS and declares zero artifacts (a resolved-empty set)
    await writeManifest(projectRoot, {
      version: 2,
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
