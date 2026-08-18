import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContext } from "../../src/core/query/context.js";
import type { MavenResolution } from "../../src/resolver/maven.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.useRealTimers();
});

/**
 * Fake timers including Date: the heartbeat's elapsed seconds come from
 * Date.now, which vitest 4 does not fake by default.
 */
function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

/** Scratch maven project dir with no manifest (forces the bootstrap path). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-heartbeat-"));
  writeFileSync(join(root, "pom.xml"), "<project/>");
  return root;
}

/**
 * Resolver overrides whose maven stub hangs until released, then answers
 * `final`. The cache scan is stubbed empty so the cascade never touches the
 * real machine; the JDK pseudo-artifact is skipped for determinism.
 */
function hangingResolver(final: Pick<MavenResolution, "ok" | "artifacts">) {
  let release!: () => void;
  const released = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const opts: ResolveDependenciesOptions = {
    includeJdk: false,
    maven: async () => {
      await released;
      return final;
    },
    cacheScan: async () => ({ artifacts: [], warnings: [] }),
  };
  return { opts, release };
}

describe("bootstrap heartbeat", () => {
  it("emits the first-run notice, one still-resolving line per 30s, then stops", async () => {
    const projectRoot = scratch();
    const { opts, release } = hangingResolver({ ok: true, artifacts: [{ coordinates: "g:a:1", kind: "external" }] });
    const notices: string[] = [];
    fakeTimers();
    const ctx = openContext(projectRoot, {
      resolvers: opts,
      onNotice: (msg) => notices.push(msg),
    });
    const ready = ctx.ensureReady();
    // flush microtasks so the bootstrap starts and the interval arms
    await vi.advanceTimersByTimeAsync(0);
    expect(notices).toEqual([
      "resolving dependencies (first run — may download dependencies and sources)",
    ]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe("still resolving (30s)");

    // 29s more: no second heartbeat yet
    await vi.advanceTimersByTimeAsync(29_000);
    expect(notices).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices[2]).toBe("still resolving (60s)");

    release();
    const result = await ready;
    await vi.advanceTimersByTimeAsync(120_000);
    // the interval is cleared once resolution settles: no further lines
    expect(notices).toHaveLength(3);
    expect(result.bootstrapped).toBe(true);
  });

  it("heartbeats stop on a failed bootstrap too, not only on success", async () => {
    const projectRoot = scratch();
    const { opts, release } = hangingResolver({ ok: false, artifacts: [] });
    const notices: string[] = [];
    fakeTimers();
    const ctx = openContext(projectRoot, {
      resolvers: opts,
      onNotice: (msg) => notices.push(msg),
    });
    const ready = ctx.ensureReady();
    await vi.advanceTimersByTimeAsync(35_000);
    release();
    const result = await ready;
    await vi.advanceTimersByTimeAsync(90_000);

    expect(notices).toEqual([
      "resolving dependencies (first run — may download dependencies and sources)",
      "still resolving (30s)",
    ]);
    expect(result.bootstrapped).toBe(false);
  });
});
