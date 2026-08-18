/**
 * Shared JVM probe: the `java -version` question every caller asks once per
 * process (status's health report, find-class's provenance promise).
 *
 * What is unit-observable here is the version-line extraction (extracted as
 * a pure helper for exactly that reason) and the memo's contract: settled
 * answers, same shape every call, never a rejection. The JAVA_HOME case runs
 * in a child process (the memo is per-process); the PATH-less spawn negative
 * lives in query-core's readMember no-JVM case; status's golden normalizes
 * the probe's machine variance.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    // honest unit assertion is the contract itself — settled, boolean answer.
    // The PATH-less spawn negative is exercised by query-core's readMember
    // no-JVM case (a PATH-less env driving the JVM-dependent decompile path),
    // not by a probe test.
    await expect(probeJvmOnce()).resolves.toMatchObject({ available: expect.any(Boolean) });
  });

  it("probes $JAVA_HOME/bin/java like CFR does when PATH has no java", () => {
    // the memo is per-process, so the JAVA_HOME case runs in a child: a fake
    // JDK home whose bin/java prints a version line to stderr and exits 0,
    // over a PATH holding only node itself (npx would be unreachable with a
    // fully empty PATH). The probe must resolve the stub — the find-class
    // provenance promise depends on probing the same java CFR will spawn,
    // and a JDK need not be on PATH at all.
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const jdkHome = mkdtempSync(join(tmpdir(), "jarpeek-jvm-home-"));
    const nodeBin = mkdtempSync(join(tmpdir(), "jarpeek-jvm-nodebin-"));
    try {
      mkdirBin(jdkHome);
      writeFileSync(join(nodeBin, "node"), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
      chmodSync(join(nodeBin, "node"), 0o755);
      const run = spawnSync(
        process.execPath,
        [
          join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          "-e",
          'import("./src/util/jvm.js").then(async (m) => process.stdout.write(JSON.stringify(await m.probeJvmOnce())))',
        ],
        {
          cwd: pkgRoot,
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, JAVA_HOME: jdkHome, PATH: nodeBin },
        },
      );
      expect(run.status, `stderr: ${run.stderr}`).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ available: true, version: "25.0.2" });
    } finally {
      rmSync(jdkHome, { recursive: true, force: true });
      rmSync(nodeBin, { recursive: true, force: true });
    }
  });

  /** A fake JDK home: `bin/java` that prints the modern version line to stderr. */
  function mkdirBin(jdkHome: string): void {
    const bin = join(jdkHome, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "java"),
      '#!/bin/sh\necho \'openjdk version "25.0.2" 2026-01-20\' >&2\nexit 0\n',
    );
    chmodSync(join(bin, "java"), 0o755);
  }
});
