import { describe, expect, it } from "vitest";
import { runWithTimeout, TimeoutError, SpawnError } from "../../src/util/exec.js";
import { splitLines, sliceLines } from "../../src/util/lines.js";

function tenLineText(): string {
  return Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
}

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
