/**
 * The resolve-only bootstrap contract: what the first query pays for, what
 * it writes, and how it degrades.
 *
 * Backoff: a resolution that throws with no manifest to serve is memoized
 * for 60s so a burst of queries degrades fast instead of re-running a
 * broken build per query. The cache-scan guard is the other half of the
 * same ladder: queries never adopt a heuristic artifact set — with a real
 * manifest on disk it is served stale (flagged), without one the bootstrap
 * fails and the query answers as a miss. A successful bootstrap writes the
 * v2 manifest and NOTHING else: `.jarpeek/` holds exactly manifest.json,
 * and the store never hears about it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContext, type OpenContextOptions, type QueryContext } from "../../src/core/query/context.js";
import { writeManifest } from "../../src/index/manifest.js";
import { findClass } from "../../src/core/query/find-class.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(import.meta.dirname!, "..", "fixtures");
const DEMO_SOURCES_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0-sources.jar");

const roots: string[] = [];

/** A tmp project with a gradle marker (so detection routes to the injected gradle resolver). */
function freshProject(): { projectRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-backoff-project-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  roots.push(projectRoot);
  return { projectRoot };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const fixtureArtifacts: DependencyArtifact[] = [
  { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
];

describe("failed-bootstrap backoff", () => {
  it("first failure runs the resolvers; the window suppresses re-runs; expiry retries", async () => {
    const { projectRoot } = freshProject();

    let calls = 0;
    let clock = 1_000_000;
    const failingGradle = async (): Promise<never> => {
      calls++;
      throw new Error("resolver exploded");
    };

    const ctx = openContext(projectRoot, {
      resolvers: { gradle: failingGradle, includeJdk: false },
      now: () => clock,
    });

    const first = await ctx.ensureReady();
    expect(first).toEqual({ bootstrapped: false, stale: false });
    expect(calls).toBe(1);
    expect(await ctx.bootstrapWarnings()).toContain("resolution failed: resolver exploded");

    // within the window: no resolver invocation, degraded warning surfaced
    clock += 10_000;
    const second = await ctx.ensureReady();
    expect(second).toEqual({ bootstrapped: false, stale: false });
    expect(calls).toBe(1);
    expect(await ctx.bootstrapWarnings()).toContain("resolution failed recently; retrying later");

    // past the window: resolution is attempted again
    clock += 51_000;
    await ctx.ensureReady();
    expect(calls).toBe(2);
  });

  it("a manifest present + failing resolver serves it stale", async () => {
    const { projectRoot } = freshProject();
    await writeManifest(projectRoot, {
      version: 2,
      resolvedAt: new Date().toISOString(),
      dependencySetHash: "stale-hash",
      artifacts: fixtureArtifacts,
    });
    let calls = 0;
    const ctx = openContext(projectRoot, {
      resolvers: {
        gradle: async () => {
          calls++;
          throw new Error("offline");
        },
        includeJdk: false,
      },
    });

    const result = await ctx.ensureReady();
    expect(result).toEqual({ bootstrapped: false, stale: true });
    expect(calls).toBe(1);
    expect(await ctx.bootstrapWarnings()).toContain("stale index served (resolution failed: offline)");
  });
});

describe("cache-scan guard", () => {
  /** Options routing every build system to failure and the caches at the fixtures. */
  function cacheScanOpts(artifacts: DependencyArtifact[]): Pick<OpenContextOptions, "resolvers"> {
    return {
      resolvers: {
        gradle: async () => ({ ok: false, artifacts: [], reason: "network down" }),
        maven: async () => ({ ok: false, artifacts: [], reason: "no pom" }),
        cacheScan: async () => ({ artifacts, warnings: [] }),
        includeJdk: false,
      },
    };
  }

  it("a real manifest present: served stale with the exact warning, never overwritten", async () => {
    const { projectRoot } = freshProject();
    await writeManifest(projectRoot, {
      version: 2,
      resolvedAt: new Date().toISOString(),
      dependencySetHash: "not-the-current-hash",
      artifacts: fixtureArtifacts,
    });
    const ctx = openContext(projectRoot, cacheScanOpts(fixtureArtifacts));

    const result = await ctx.ensureReady();
    expect(result).toEqual({ bootstrapped: false, stale: true });
    expect(await ctx.bootstrapWarnings()).toContain(
      "stale index served (resolution degraded to cache scan)",
    );
    // the heuristic set never replaces a manifest a build tool produced
    const manifest = await ctx.manifest();
    expect(manifest?.artifacts.map((a) => a.coordinates)).toEqual(["com.example:demo-lib:1.0.0"]);
  });

  it("no manifest: the bootstrap fails, warns exactly, and backs off", async () => {
    const { projectRoot } = freshProject();
    let clock = 5_000_000;
    let scans = 0;
    const ctx = openContext(projectRoot, {
      resolvers: {
        gradle: async () => ({ ok: false, artifacts: [], reason: "network down" }),
        maven: async () => ({ ok: false, artifacts: [], reason: "no pom" }),
        cacheScan: async () => {
          scans++;
          return { artifacts: fixtureArtifacts, warnings: [] };
        },
        includeJdk: false,
      },
      now: () => clock,
    });

    const result = await ctx.ensureReady();
    expect(result).toEqual({ bootstrapped: false, stale: false });
    expect(await ctx.bootstrapWarnings()).toContain(
      "resolution failed: degraded to cache-scan; run jarpeek resolve",
    );
    // no manifest was written for the heuristic set
    expect(await ctx.manifest()).toBeNull();

    // inside the backoff window the cache scan is not re-run either
    clock += 10_000;
    await ctx.ensureReady();
    expect(scans).toBe(1);

    // and the query answers as a miss: find-class finds nothing
    const found = await findClass(ctx, "com.example.Demo");
    expect(found.hits).toEqual([]);
  });
});

describe("successful resolve-only bootstrap", () => {
  it("writes the v2 manifest and nothing else; onNotice fires exactly once", async () => {
    const { projectRoot } = freshProject();
    const notices: string[] = [];
    const ctx = openContext(projectRoot, {
      resolvers: { gradle: async () => ({ ok: true, artifacts: fixtureArtifacts }), includeJdk: false },
      onNotice: (msg) => notices.push(msg),
    });

    const result = await ctx.ensureReady();
    expect(result).toEqual({ bootstrapped: true, stale: false });
    expect(notices).toEqual(["resolving dependencies (first run)"]);

    // the resolve-only bootstrap's whole footprint: manifest.json, nothing else
    expect(readdirSync(join(projectRoot, ".jarpeek"))).toEqual(["manifest.json"]);
    const manifest = await ctx.manifest();
    expect(manifest?.version).toBe(2);
    expect(manifest?.artifacts.map((a) => a.coordinates)).toEqual(["com.example:demo-lib:1.0.0"]);
    // the fresh manifest is served as-is on the next query
    expect(notices).toEqual(["resolving dependencies (first run)"]);
    expect(await ctx.ensureReady()).toEqual({ bootstrapped: false, stale: false });
  });

  it("a stale manifest bootstraps again with the stale-run notice", async () => {
    const { projectRoot } = freshProject();
    const notices: string[] = [];
    const ctx = openContext(projectRoot, {
      resolvers: { gradle: async () => ({ ok: true, artifacts: fixtureArtifacts }), includeJdk: false },
      onNotice: (msg) => notices.push(msg),
    });
    await ctx.ensureReady();
    expect(notices).toEqual(["resolving dependencies (first run)"]);

    // the build file moves: the next query re-resolves under the stale notice
    const gradle = join(projectRoot, "build.gradle");
    writeFileSync(gradle, "plugins { id 'java' }\n// changed\n");
    const future = new Date(Date.now() + 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(gradle, future, future);

    const result = await ctx.ensureReady();
    expect(result).toEqual({ bootstrapped: true, stale: true });
    expect(notices).toEqual([
      "resolving dependencies (first run)",
      "resolving dependencies (manifest stale)",
    ]);
  });
});

describe("fresh-project query end-to-end", () => {
  it("find-class auto-resolves (notice once) and answers from the listing", async () => {
    const { projectRoot } = freshProject();
    const notices: string[] = [];
    const ctx: QueryContext = openContext(projectRoot, {
      resolvers: { gradle: async () => ({ ok: true, artifacts: fixtureArtifacts }), includeJdk: false },
      onNotice: (msg) => notices.push(msg),
    });

    const result = await findClass(ctx, "com.example.Demo");
    expect(result.hits.map((hit) => hit.fqn)).toContain("com.example.Demo");
    expect(notices).toEqual(["resolving dependencies (first run)"]);

    const manifest = await ctx.manifest();
    expect(manifest?.version).toBe(2);
    expect(manifest?.artifacts[0]?.coordinates).toBe("com.example:demo-lib:1.0.0");
  });
});
