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
import { handleMiss } from "../../src/core/miss.js";
import { LookupMissError } from "../../src/core/query/outline.js";
import { resolveNow } from "../../src/core/query/resolve-cmd.js";
import { computeDependencySetHash, readManifest, writeManifest } from "../../src/index/manifest.js";
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

describe("partial-resolution persistence (GH#18)", () => {
  /** A Maven-detected project (partial resolution is the Maven reactor's failure mode). */
  function pomProject(): { projectRoot: string } {
    const { projectRoot } = freshProject();
    rmSync(join(projectRoot, "build.gradle"));
    writeFileSync(join(projectRoot, "pom.xml"), "<project/>");
    return { projectRoot };
  }

  it("a partial bootstrap persists its degraded state — a fresh process serving the fresh manifest still reports it", async () => {
    const { projectRoot } = pomProject();
    const artifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:partial-lib:1.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ];
    let calls = 0;
    const resolvers = {
      maven: async () => {
        calls++;
        return {
          ok: true,
          artifacts,
          partial: "modules failed to resolve: mod ([ERROR] sibling was not found)",
        };
      },
      includeJdk: false,
    };
    const first = openContext(projectRoot, { resolvers });
    await first.ensureReady();
    expect(calls).toBe(1);

    // the manifest the partial bootstrap wrote records the truncation —
    // without this, the incomplete set is indistinguishable from a complete
    // one on disk
    const written = await readManifest(projectRoot);
    expect(written?.incomplete).toEqual([
      { from: "maven", reason: "modules failed to resolve: mod ([ERROR] sibling was not found)" },
    ]);

    // the exact false-negative machine from the issue: a later invocation,
    // fresh process, manifest hashes fresh → served without bootstrapping —
    // and the persisted incompleteness still reaches the warning channel
    const second = openContext(projectRoot, { resolvers });
    const served = await second.ensureReady();
    expect(served).toEqual({ bootstrapped: false, stale: false });
    expect(calls).toBe(1); // never re-resolved: serving, not retrying
    expect(await second.bootstrapWarnings()).toContain(
      "maven: modules failed to resolve: mod ([ERROR] sibling was not found)",
    );
  });

  it("a clean re-resolve clears the persisted incompleteness", async () => {
    const { projectRoot } = pomProject();
    const artifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:partial-lib:1.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ];
    let partial = true;
    const resolvers = {
      maven: async () =>
        partial
          ? { ok: true, artifacts, partial: "modules failed to resolve: mod ([ERROR] broken)" }
          : { ok: true, artifacts },
      includeJdk: false,
    };
    await openContext(projectRoot, { resolvers }).ensureReady();
    expect((await readManifest(projectRoot))?.incomplete).toBeDefined();

    // the build heals and the manifest goes stale: the next bootstrap writes
    // a complete manifest, and the persisted flag must not survive it
    partial = false;
    const pom = join(projectRoot, "pom.xml");
    const future = new Date(Date.now() + 60_000);
    utimesSync(pom, future, future);
    const healed = openContext(projectRoot, { resolvers });
    await healed.ensureReady();
    expect(await healed.bootstrapWarnings()).toEqual([]);
    expect((await readManifest(projectRoot))?.incomplete).toBeUndefined();
  });

  it("resolveNow persists the same incompleteness — and clears it on a clean resolve", async () => {
    const { projectRoot } = pomProject();
    const artifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:partial-lib:1.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ];
    let partial = true;
    const resolvers = {
      maven: async () =>
        partial
          ? { ok: true, artifacts, partial: "modules failed to resolve: mod ([ERROR] broken)" }
          : { ok: true, artifacts },
      includeJdk: false,
    };

    // the explicit resolve writes the flag just like the bootstrap does
    const result = await resolveNow(openContext(projectRoot, { resolvers }));
    expect(result.degraded).toEqual([
      { from: "maven", reason: "modules failed to resolve: mod ([ERROR] broken)" },
    ]);
    expect((await readManifest(projectRoot))?.incomplete).toEqual([
      { from: "maven", reason: "modules failed to resolve: mod ([ERROR] broken)" },
    ]);

    // and a clean forced resolve clears it — no staleness dance needed
    partial = false;
    await resolveNow(openContext(projectRoot, { resolvers }));
    expect((await readManifest(projectRoot))?.incomplete).toBeUndefined();
  });

  it("a failed cascade sibling does NOT flag the manifest — the winning set is complete (GH#18 review)", async () => {
    // hybrid project (gradle marker + pom.xml): gradle fails, maven answers
    // COMPLETELY — the gradle failure stays a warning, but the served set is
    // exhaustive, so no `incomplete` may persist and negatives stay definitive
    const { projectRoot } = pomProject();
    writeFileSync(join(projectRoot, "settings.gradle"), "");
    const artifacts: DependencyArtifact[] = [
      {
        coordinates: "com.example:hybrid-lib:1.0",
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ];
    const resolvers = {
      gradle: async () => ({ ok: false as const, artifacts: [], reason: "no-wrapper-no-gradle" }),
      maven: async () => ({ ok: true as const, artifacts }),
      includeJdk: false,
    };
    const ctx = openContext(projectRoot, { resolvers });
    await ctx.ensureReady();

    expect(await ctx.bootstrapWarnings()).toContain("gradle: no-wrapper-no-gradle");
    const manifest = await readManifest(projectRoot);
    expect(manifest?.incomplete).toBeUndefined();

    // and a miss over it is a genuine negative, not a flagged one
    const miss = await handleMiss(ctx, new LookupMissError("com.example.Nowhere"));
    expect(miss.found).toBe(false);
    if (miss.found) throw new Error("unreachable");
    expect(miss.incomplete).toBe(false);
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
      dependencySetHash: await computeDependencySetHash(projectRoot, "auto", ctx.roots.m2[0].path),
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
