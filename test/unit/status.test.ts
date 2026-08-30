/**
 * status: the one-call health report, minus the index — manifest freshness
 * and JVM availability only. The manifest is written directly per suite
 * (fixture-manifest world: `writeManifest` with a matching
 * `dependencySetHash` so `isStale` is false and the store is never read),
 * which is what makes "status must not touch the index" observable: these
 * suites never index, so any index field would answer zero anyway — the
 * assertion is that the keys are gone from the object entirely.
 *
 * The JVM probe is injected through the `opts.jvm` seam (tests must not
 * depend on the host machine having a `java`); the default is the shared
 * per-process probe.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { renderStatus } from "../../src/cli/index.js";
import { status } from "../../src/core/query/status.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const JARS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "jars");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");

const roots: string[] = [];

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-status-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A context over a manifest hashing under the context's own primary root (fresh, non-stale). */
async function contextWith(artifacts: DependencyArtifact[]): Promise<{ ctx: QueryContext; root: string }> {
  const root = freshRoot();
  writeFileSync(join(root, "build.gradle"), "plugins { id 'java' }\n");
  const ctx = openContext(root, { onNotice: () => {} });
  await writeManifest(root, {
    version: 2,
    resolvedAt: "2026-08-17T00:00:00.000Z",
    dependencySetHash: await computeDependencySetHash(root, "auto", ctx.roots.m2[0].path),
    artifacts,
  });
  return { ctx, root };
}

const JVM = { available: true, version: "25.0.2" };

describe("status without the index", () => {
  let ctx: QueryContext;
  let root: string;

  beforeAll(async () => {
    ({ ctx, root } = await contextWith([
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
      { coordinates: "com.example:demo-lib-bin:1.0.0", kind: "external" },
    ]));
  });

  it("reports the manifest and the injected jvm probe", async () => {
    const result = await status(ctx, { jvm: () => Promise.resolve(JVM) });
    expect(result.projectRoot).toBe(root);
    expect(result.manifest.present).toBe(true);
    expect(result.manifest.artifactCount).toBe(2);
    expect(result.manifest.resolvedAt).toBe("2026-08-17T00:00:00.000Z");
    expect(result.manifest.stale).toBe(false);
    expect(typeof result.manifest.dependencySetHash).toBe("string");
    expect(result.jvm).toEqual(JVM);
    expect(result.degraded).toEqual([]);
  });

  it("carries no index key", async () => {
    const result = await status(ctx, { jvm: () => Promise.resolve(JVM) });
    expect(Object.keys(result)).not.toContain("index");
    expect(Object.keys(result)).not.toContain("cacheDir");
  });

  it("stale flips true after a build file moves", async () => {
    const gradle = join(root, "build.gradle");
    const future = new Date(Date.now() + 60_000);
    utimesSync(gradle, future, future);
    try {
      const result = await status(ctx, { jvm: () => Promise.resolve(JVM) });
      expect(result.manifest.stale).toBe(true);
      // the degraded channel carries the same honesty as the sibling tools
      expect(result.degraded.some((d) => d.includes("stale"))).toBe(true);
    } finally {
      // restore a fresh fingerprint so the shared suite's other cases stay honest
      writeFileSync(gradle, "plugins { id 'java' }\n");
    }
  });

  it("defaults to the shared per-process probe when no seam is given", async () => {
    const result = await status(ctx);
    expect(typeof result.jvm.available).toBe("boolean");
  });
});

describe("status on a manifest-less project", () => {
  it("reports present false, artifactCount 0, and never throws", async () => {
    const root = freshRoot();
    writeFileSync(join(root, "build.gradle"), "plugins { id 'java' }\n");
    const ctx = openContext(root, { onNotice: () => {} });
    const result = await status(ctx, { jvm: () => Promise.resolve({ available: false }) });
    expect(result.manifest.present).toBe(false);
    expect(result.manifest.artifactCount).toBe(0);
    expect(result.manifest.stale).toBe(false);
    expect(result.manifest.resolvedAt).toBeUndefined();
    expect(result.jvm).toEqual({ available: false });
    expect(result.degraded).toEqual([]);
  });
});

describe("status resolver roots", () => {
  it("reports the context's effective roots with their source layers", async () => {
    const { ctx } = await contextWith([]);
    vi.stubEnv("JARPEEK_M2_DIR", "/custom/m2");
    vi.stubEnv("JARPEEK_GRADLE_CACHE_DIR", "/custom/gradle");

    // the env stub postdates this context — a fresh one converges under it
    const fresh = openContext(ctx.projectRoot, { onNotice: () => {} });
    const result = await status(fresh, { jvm: () => Promise.resolve(JVM) });

    expect(result.resolver.m2Root).toEqual({ path: "/custom/m2", source: "env" });
    expect(result.resolver.gradleCacheRoot).toEqual({ path: "/custom/gradle", source: "env" });
    // the CLI table renders the row as `<path> (<source>)`
    const table = renderStatus(result);
    expect(table).toContain("resolver.m2Root");
    expect(table).toContain("/custom/m2 (env)");
    expect(table).toContain("resolver.gradleCacheRoot");
    expect(table).toContain("/custom/gradle (env)");
  });

  // unix-only: hermetic default-source assertions need HOME relocated (the
  // settings.xml and default-root layers read the real home; win32 homedir
  // ignores $HOME)
  it.skipIf(process.platform === "win32")(
    "reports the default roots when nothing is configured",
    async () => {
      const root = freshRoot();
      writeFileSync(join(root, "build.gradle"), "plugins { id 'java' }\n");
      const home = mkdtempSync(join(tmpdir(), "jarpeek-status-home-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("JARPEEK_HOME", home);
      for (const name of ["JARPEEK_M2_DIR", "M2_REPO", "JARPEEK_GRADLE_CACHE_DIR", "GRADLE_USER_HOME"]) {
        vi.stubEnv(name, "");
      }

      const result = await status(openContext(root, { onNotice: () => {} }), {
        jvm: () => Promise.resolve(JVM),
      });

      expect(result.resolver.m2Root).toEqual({
        path: join(home, ".m2", "repository"),
        source: "default",
      });
      expect(result.resolver.gradleCacheRoot).toEqual({
        path: join(home, ".gradle", "caches", "modules-2", "files-2.1"),
        source: "default",
      });
    },
  );
});
