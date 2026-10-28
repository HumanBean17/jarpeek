/**
 * The shared manifest cache seen through openContext: a worktree whose
 * build files match an already-resolved checkout answers without running
 * the build, and parallel bootstraps of the same build files (sibling
 * worktrees, parallel agents) run the resolver exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContext } from "../../src/core/query/context.js";
import { moduleNamespace } from "../../src/resolver/module-coordinate.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";

const roots: string[] = [];

/** A checkout of the same two-module Gradle build. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "jarpeek-shared-"));
  roots.push(root);
  writeFileSync(join(root, "settings.gradle"), "include 'app'\n");
  writeFileSync(join(root, "build.gradle"), "plugins {}\n");
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app", "build.gradle"), "plugins { id 'java' }\n");
  return root;
}

/** A gradle stub reporting one module of whichever checkout it runs in; counts runs. */
function countingGradle(seen: { calls: number }, delayMs = 0): ResolveDependenciesOptions {
  return {
    includeJdk: false,
    gradle: async (projectRoot) => {
      seen.calls++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        ok: true,
        artifacts: [
          { coordinates: `module:${moduleNamespace(projectRoot)}:app`, kind: "module", sourceDir: join(projectRoot, "app") },
        ],
      };
    },
  };
}

// every case starts from an empty cache: they all resolve the same build files
beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "jarpeek-shared-cache-"));
  roots.push(cache);
  process.env.JARPEEK_CACHE_DIR = cache;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shared manifest cache", () => {
  it("a second checkout of the same build answers from the cache, rebased onto itself", async () => {
    const seen = { calls: 0 };
    const main = checkout();
    const worktree = checkout();

    expect((await openContext(main, { resolvers: countingGradle(seen) }).ensureReady()).bootstrapped).toBe(true);

    const ctx = openContext(worktree, { resolvers: countingGradle(seen) });
    expect(await ctx.ensureReady()).toEqual({ bootstrapped: false, stale: false });
    expect(seen.calls).toBe(1);
    expect(await ctx.artifacts()).toEqual([
      { coordinates: `module:${moduleNamespace(worktree)}:app`, kind: "module", sourceDir: join(worktree, "app") },
    ]);
    expect(existsSync(join(worktree, ".jarpeek"))).toBe(false);
  });

  it("parallel bootstraps of identical build files resolve once; the waiter is told why it waits", async () => {
    const seen = { calls: 0 };
    const notices: string[] = [];
    const contexts = [checkout(), checkout(), checkout()].map((root) =>
      openContext(root, { resolvers: countingGradle(seen, 200), onNotice: (msg) => notices.push(msg) }),
    );
    const results = await Promise.all(contexts.map((ctx) => ctx.ensureReady()));

    expect(seen.calls).toBe(1);
    expect(results.filter((r) => r.bootstrapped)).toHaveLength(1);
    expect(notices).toContain("waiting for a concurrent resolve of the same build");
    for (const ctx of contexts) expect(await ctx.artifacts()).toHaveLength(1);
  });

  it("diverged build files resolve separately", async () => {
    const seen = { calls: 0 };
    const main = checkout();
    const branch = checkout();
    writeFileSync(join(branch, "app", "build.gradle"), "plugins { id 'java-library' }\n");

    await openContext(main, { resolvers: countingGradle(seen) }).ensureReady();
    expect((await openContext(branch, { resolvers: countingGradle(seen) }).ensureReady()).bootstrapped).toBe(true);
    expect(seen.calls).toBe(2);
  });
});
