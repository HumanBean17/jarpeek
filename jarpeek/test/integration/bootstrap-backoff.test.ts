/**
 * The failed-bootstrap backoff: when resolution throws and there is no
 * manifest to serve, the failure is memoized for 60s so a burst of queries
 * degrades fast instead of re-running a broken build per query.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContext, type QueryContext } from "../../src/core/query/context.js";

const c = { ctx: undefined as unknown as QueryContext, projectRoot: "", cacheDir: "", calls: () => 0, advance: (_ms: number) => {} };

beforeAll(() => {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-backoff-project-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "jarpeek-backoff-cache-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");

  let calls = 0;
  let clock = 1_000_000;
  const failingGradle = async (): Promise<never> => {
    calls++;
    throw new Error("resolver exploded");
  };

  const ctx = openContext(projectRoot, {
    resolvers: { gradle: failingGradle, includeJdk: false },
    cacheDir,
    onProgress: () => {},
    now: () => clock,
  });

  Object.assign(c, {
    ctx,
    projectRoot,
    cacheDir,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
  });
});

afterAll(() => {
  rmSync(c.projectRoot, { recursive: true, force: true });
  rmSync(c.cacheDir, { recursive: true, force: true });
});

describe("failed-bootstrap backoff", () => {
  it("first failure runs the resolvers; the window suppresses re-runs; expiry retries", async () => {
    const first = await c.ctx.ensureReady();
    expect(first).toEqual({ bootstrapped: false, stale: false });
    expect(c.calls()).toBe(1);
    expect(await c.ctx.bootstrapWarnings()).toContain("resolution failed: resolver exploded");

    // within the window: no resolver invocation, degraded warning surfaced
    c.advance(10_000);
    const second = await c.ctx.ensureReady();
    expect(second).toEqual({ bootstrapped: false, stale: false });
    expect(c.calls()).toBe(1);
    expect(await c.ctx.bootstrapWarnings()).toContain("resolution failed recently; retrying later");

    // past the window: resolution is attempted again
    c.advance(51_000);
    await c.ctx.ensureReady();
    expect(c.calls()).toBe(2);
  });
});
