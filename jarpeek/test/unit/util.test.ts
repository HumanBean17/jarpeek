import { describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock, LockTimeoutError } from "../../src/util/lockfile.js";
import { runWithTimeout, TimeoutError, SpawnError } from "../../src/util/exec.js";
import { splitLines, sliceLines } from "../../src/util/lines.js";

function tmpCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-util-"));
}

function tenLineText(): string {
  return Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
}

describe("withLock", () => {
  it("two sequential calls on the same cache dir both succeed", async () => {
    const dir = tmpCacheDir();
    try {
      const first = await withLock(dir, async () => "a");
      const second = await withLock(dir, async () => "b");
      expect(first).toBe("a");
      expect(second).toBe("b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a lock file containing pid and iso timestamp, and releases after", async () => {
    const dir = tmpCacheDir();
    const lockPath = join(dir, "jarpeek.lock");
    try {
      let observed: string | undefined;
      await withLock(dir, async () => {
        observed = await import("node:fs/promises").then((m) => m.readFile(lockPath, "utf8"));
      });
      expect(observed).toBeDefined();
      const [pid, iso] = (observed as string).split("\n");
      expect(Number(pid)).toBe(process.pid);
      expect(new Date(iso).toString()).not.toBe("Invalid Date");
      expect(statSync(lockPath, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("steals a stale lock older than 10 minutes", async () => {
    const dir = tmpCacheDir();
    const lockPath = join(dir, "jarpeek.lock");
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    try {
      writeFileSync(lockPath, "999999\n2020-01-01T00:00:00.000Z\n", { flag: "wx" });
      utimesSync(lockPath, elevenMinutesAgo, elevenMinutesAgo);
      const result = await withLock(dir, async () => "stolen-ok");
      expect(result).toBe("stolen-ok");
      expect(statSync(lockPath, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries on a fresh foreign lock and succeeds once it disappears", async () => {
    const dir = tmpCacheDir();
    const lockPath = join(dir, "jarpeek.lock");
    try {
      const fd = openSync(lockPath, "wx");
      const start = Date.now();
      setTimeout(() => {
        closeSync(fd);
        rmSync(lockPath, { force: true });
      }, 300);
      const result = await withLock(dir, async () => "retried-ok");
      const elapsed = Date.now() - start;
      expect(result).toBe("retried-ok");
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(6000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws LockTimeoutError after 50 retries when the lock never clears", async () => {
    const dir = tmpCacheDir();
    const lockPath = join(dir, "jarpeek.lock");
    writeFileSync(lockPath, "1\n2026-01-01T00:00:00.000Z\n", { flag: "wx" });
    const start = Date.now();
    let error: unknown;
    try {
      await withLock(dir, async () => "never");
    } catch (e) {
      error = e;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const elapsed = Date.now() - start;
    expect(error).toBeInstanceOf(LockTimeoutError);
    expect((error as Error).name).toBe("LockTimeoutError");
    expect(elapsed).toBeGreaterThanOrEqual(4000);
  });
});

describe("runWithTimeout", () => {
  it("resolves with stdout and code 0 for a successful command", async () => {
    const result = await runWithTimeout(process.execPath, ["-e", "console.log('hi')"]);
    expect(result.stdout).toContain("hi");
    expect(result.code).toBe(0);
  });

  it("rejects with TimeoutError when the command runs past timeoutMs", async () => {
    const start = Date.now();
    let error: unknown;
    try {
      await runWithTimeout(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { timeoutMs: 200 });
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - start;
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).name).toBe("TimeoutError");
    expect(elapsed).toBeLessThan(5000);
  });

  it("rejects with SpawnError for a missing binary", async () => {
    let error: unknown;
    try {
      await runWithTimeout("definitely-not-a-real-binary-xyz", []);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SpawnError);
    expect((error as Error).name).toBe("SpawnError");
    expect((error as Error).message).toContain("definitely-not-a-real-binary-xyz");
  });

  it("resolves (not rejects) with the exit code for a non-zero exit", async () => {
    const result = await runWithTimeout(process.execPath, ["-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });
});

describe("splitLines", () => {
  it("splits on \\n and strips trailing \\r (CRLF-safe)", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty text", () => {
    expect(splitLines("")).toEqual([]);
  });
});

describe("sliceLines", () => {
  it("returns in-range slice with clamped false", () => {
    const result = sliceLines(tenLineText(), 3, 5);
    expect(result.lines).toEqual(["line-3", "line-4", "line-5"]);
    expect(result.startLine).toBe(3);
    expect(result.endLine).toBe(5);
    expect(result.clamped).toBe(false);
  });

  it("clamps out-of-range upper bound with clamped true", () => {
    const result = sliceLines(tenLineText(), 8, 15);
    expect(result.lines).toEqual(["line-8", "line-9", "line-10"]);
    expect(result.startLine).toBe(8);
    expect(result.endLine).toBe(10);
    expect(result.clamped).toBe(true);
  });

  it("clamps out-of-range lower bound with clamped true", () => {
    const result = sliceLines(tenLineText(), -2, 3);
    expect(result.lines).toEqual(["line-1", "line-2", "line-3"]);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.clamped).toBe(true);
  });

  it("yields empty lines for empty text", () => {
    const result = sliceLines("", 1, 10);
    expect(result.lines).toEqual([]);
    expect(result.clamped).toBe(true);
  });
});
