/**
 * The context's cache-root convergence: `openContext` computes the effective
 * roots once (the same single-call-site rule the build-tool strategy
 * follows), exposes them with their source layers for `status`, and threads
 * the plain paths into the resolvers. The fingerprint side (an m2 root flip
 * re-resolves) lives in manifest.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openContext } from "../../src/core/query/context.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";

let root: string |undefined;

/** Fresh scratch maven project (cleaned in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-ctx-roots-"));
  writeFileSync(join(root, "pom.xml"), "<project/>");
  return root;
}

/** Pin the env layer off unless a test pins it on. */
function noEnv(): void {
  for (const name of ["JARPEEK_M2_DIR", "M2_REPO", "JARPEEK_GRADLE_CACHE_DIR", "GRADLE_USER_HOME"]) {
    vi.stubEnv(name, "");
  }
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
});

describe("openContext roots convergence", () => {
  it("exposes the env-steered roots and threads the plain paths into the resolvers", async () => {
    noEnv();
    const projectRoot = scratch();
    const seen: { roots?: { m2: string[]; gradle: string } } = {};
    const resolvers: ResolveDependenciesOptions = {
      includeJdk: false,
      maven: async (_projectRoot, opts) => {
        seen.roots = opts?.roots;
        return { ok: true, artifacts: [{ coordinates: "g:a:1", kind: "external" }] };
      },
      cacheScan: async () => ({ artifacts: [], warnings: [] }),
    };
    vi.stubEnv("JARPEEK_M2_DIR", "/custom/m2");
    vi.stubEnv("JARPEEK_GRADLE_CACHE_DIR", "/custom/gradle");

    const ctx = openContext(projectRoot, { resolvers });
    await ctx.ensureReady();

    expect(ctx.roots.m2[0]).toEqual({ path: "/custom/m2", source: "env" });
    // the threaded list is the full chain — env root first, default anchoring last
    expect(seen.roots).toEqual({
      m2: ["/custom/m2", join(homedir(), ".m2", "repository")],
      gradle: "/custom/gradle",
    });
  });

  it("recomputes per context — a different env is a different convergence", () => {
    noEnv();
    const projectRoot = scratch();
    vi.stubEnv("JARPEEK_M2_DIR", "/first/m2");
    const first = openContext(projectRoot);
    vi.stubEnv("JARPEEK_M2_DIR", "/second/m2");
    const second = openContext(projectRoot);

    expect(first.roots.m2[0].path).toBe("/first/m2");
    expect(second.roots.m2[0].path).toBe("/second/m2");
  });
});
