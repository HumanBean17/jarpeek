/**
 * Shared JVM probe: the `java -version` question every caller asks once per
 * process (status's health report, find-class's provenance promise).
 *
 * The probe spawn is covered by the integration status cases; what is
 * unit-observable here is the version-line extraction (extracted as a pure
 * helper for exactly that reason) and the memo's contract: settled answers,
 * same shape every call, never a rejection.
 */
import { describe, expect, it } from "vitest";
import { extractJvmVersion, probeJvmOnce } from "../../src/util/jvm.js";

describe("extractJvmVersion", () => {
  it("finds the version line in stderr (modern JVMs print there)", () => {
    expect(
      extractJvmVersion({
        stdout: "",
        stderr: 'openjdk version "25.0.2" 2026-01-20\nOpenJDK Runtime Environment\n',
      }),
    ).toBe("25.0.2");
  });

  it("falls back to stdout for old JVMs that printed there", () => {
    expect(extractJvmVersion({ stdout: 'java version "1.8.0_392"\n', stderr: "" })).toBe("1.8.0_392");
  });

  it("prefers stderr when both carry a version line", () => {
    expect(
      extractJvmVersion({ stdout: 'java version "9"\n', stderr: 'openjdk version "25"\n' }),
    ).toBe("25");
  });

  it("no version line anywhere answers undefined", () => {
    expect(extractJvmVersion({ stdout: "garbage\n", stderr: "also garbage\n" })).toBeUndefined();
    expect(extractJvmVersion({ stdout: "", stderr: "" })).toBeUndefined();
  });

  it("ignores a quoted string that is not a version line", () => {
    expect(extractJvmVersion({ stdout: "", stderr: 'vm "stuff" here\n' })).toBeUndefined();
  });
});

describe("probeJvmOnce", () => {
  it("memoizes: two calls resolve the same answer shape", async () => {
    const first = await probeJvmOnce();
    const second = await probeJvmOnce();
    expect(first).toEqual(second);
    expect(typeof first.available).toBe("boolean");
    if (first.available) expect(first.version === undefined || typeof first.version === "string").toBe(true);
  });

  it("never rejects: a failed spawn is the unavailable answer", async () => {
    // the module memo may already hold this process's real probe, so the
    // honest unit assertion is the contract itself — settled, boolean answer
    // (the PATH-less spawn negative is covered by the integration status
    // cases, which run in their own processes)
    await expect(probeJvmOnce()).resolves.toMatchObject({ available: expect.any(Boolean) });
  });
});
