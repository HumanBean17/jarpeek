/**
 * The context's build-tool convergence: flag > env > config > auto, computed
 * once per openContext, threaded into the resolvers AND the manifest
 * fingerprint so a strategy flip re-resolves instead of serving the other
 * tool's manifest. An explicitly injected `resolvers.strategy` (tests,
 * library callers) wins over convergence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContext } from "../../src/core/query/context.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";

let root: string | undefined;

/** Fresh scratch maven project (cleaned in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-ctx-strategy-"));
  writeFileSync(join(root, "pom.xml"), "<project/>");
  return root;
}

/** Pin the env layer off unless a test pins it on. */
function noEnv(): void {
  vi.stubEnv("JARPEEK_BUILD_TOOL", "");
}

/** Write `.jarpeek/config.json` with the given raw content. */
function writeConfig(projectRoot: string, content: string): void {
  mkdirSync(join(projectRoot, ".jarpeek"), { recursive: true });
  writeFileSync(join(projectRoot, ".jarpeek", "config.json"), content);
}

/**
 * Resolver overrides whose maven stub records the strategy it received (and
 * how many times it ran); the JDK is skipped so nothing real is touched.
 */
function capturingMaven(seen: { strategy?: string; calls: number }): ResolveDependenciesOptions {
  return {
    includeJdk: false,
    maven: async (_projectRoot, opts) => {
      seen.calls++;
      seen.strategy = opts?.strategy;
      return { ok: true, artifacts: [{ coordinates: "g:a:1", kind: "external" }] };
    },
    cacheScan: async () => ({ artifacts: [], warnings: [] }),
  };
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
});

describe("openContext build-tool strategy", () => {
  it("passes the flag value to the resolvers", async () => {
    noEnv();
    const projectRoot = scratch();
    const seen = { calls: 0 };
    const ctx = openContext(projectRoot, {
      buildToolFlag: "wrapper",
      resolvers: capturingMaven(seen),
    });

    expect(ctx.buildTool).toBe("wrapper");
    await ctx.ensureReady();

    expect(seen).toEqual({ calls: 1, strategy: "wrapper" });
  });

  it("converges from the env var when no flag is given", async () => {
    vi.stubEnv("JARPEEK_BUILD_TOOL", "system");
    const projectRoot = scratch();
    const seen = { calls: 0 };
    const ctx = openContext(projectRoot, { resolvers: capturingMaven(seen) });

    expect(ctx.buildTool).toBe("system");
    await ctx.ensureReady();

    expect(seen).toEqual({ calls: 1, strategy: "system" });
  });

  it("converges from config.json when neither flag nor env is set", async () => {
    noEnv();
    const projectRoot = scratch();
    writeConfig(projectRoot, JSON.stringify({ buildTool: "wrapper" }));
    const seen = { calls: 0 };
    const ctx = openContext(projectRoot, { resolvers: capturingMaven(seen) });

    expect(ctx.buildTool).toBe("wrapper");
    await ctx.ensureReady();

    expect(seen).toEqual({ calls: 1, strategy: "wrapper" });
  });

  it("the flag beats the env var", async () => {
    vi.stubEnv("JARPEEK_BUILD_TOOL", "wrapper");
    const projectRoot = scratch();
    const seen = { calls: 0 };
    const ctx = openContext(projectRoot, {
      buildToolFlag: "system",
      resolvers: capturingMaven(seen),
    });

    expect(ctx.buildTool).toBe("system");
    await ctx.ensureReady();

    expect(seen).toEqual({ calls: 1, strategy: "system" });
  });

  it("an injected resolvers.strategy wins over convergence", async () => {
    vi.stubEnv("JARPEEK_BUILD_TOOL", "system");
    const projectRoot = scratch();
    const seen = { calls: 0 };
    const ctx = openContext(projectRoot, {
      resolvers: { ...capturingMaven(seen), strategy: "wrapper" },
    });

    expect(ctx.buildTool).toBe("wrapper");
    await ctx.ensureReady();

    expect(seen).toEqual({ calls: 1, strategy: "wrapper" });
  });

  it("nothing set resolves as auto, visible on ctx.buildTool", async () => {
    noEnv();
    const projectRoot = scratch();
    const seen = { calls: 0 };
    const ctx = openContext(projectRoot, { resolvers: capturingMaven(seen) });

    expect(ctx.buildTool).toBe("auto");
    await ctx.ensureReady();
    expect(seen).toEqual({ calls: 1, strategy: "auto" });
  });

  it("a strategy flip re-bootstraps: the fingerprint keys to the strategy", async () => {
    noEnv();
    const projectRoot = scratch();
    const seen = { calls: 0 };

    const first = openContext(projectRoot, {
      buildToolFlag: "wrapper",
      resolvers: capturingMaven(seen),
    });
    const firstReady = await first.ensureReady();
    expect(firstReady).toEqual({ bootstrapped: true, stale: false });

    // same project, same build files, different strategy: the manifest is
    // stale (that is why the re-resolve happens), so the run reports
    // stale: true while still bootstrapping
    const second = openContext(projectRoot, {
      buildToolFlag: "system",
      resolvers: capturingMaven(seen),
    });
    const secondReady = await second.ensureReady();
    expect(secondReady).toEqual({ bootstrapped: true, stale: true });
    expect(seen.calls).toBe(2); // re-resolved, not served from the wrapper-keyed manifest
  });
});
