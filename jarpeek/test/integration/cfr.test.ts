import { afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CFR_VERSION, cfrJarPath, decompileClass, type DecompileResult } from "../../src/decompile/cfr.js";
import { parseJavaSource } from "../../src/parse/java-lexer.js";
import { SpawnError } from "../../src/util/exec.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOSOURCES_JAR = join(FIXTURES, "jars", "nosources-lib-1.0.0.jar");
const HIDDEN = "com/example/nosources/Hidden";
const COORDINATES = "com.example:nosources-lib:1.0.0";

const tmpDirs: string[] = [];
function newCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-cfr-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function asDecompiled(r: DecompileResult): Extract<DecompileResult, { provenance: "decompiled" }> {
  if (r.provenance !== "decompiled") throw new Error(`expected decompiled, got ${JSON.stringify(r)}`);
  return r;
}

function asSignature(r: DecompileResult): Extract<DecompileResult, { provenance: "signature" }> {
  if (r.provenance !== "signature") throw new Error(`expected signature, got ${JSON.stringify(r)}`);
  return r;
}

const hasJava = !spawnSync("java", ["-version"], { stdio: "ignore" }).error;
const withJava = hasJava ? describe : describe.skip;

describe("cfrJarPath", () => {
  it("points at the vendored jar (> 1MB)", () => {
    const jar = cfrJarPath();
    expect(statSync(jar).size).toBeGreaterThan(1024 * 1024);
  });

  it("pins the vendored CFR version", () => {
    expect(CFR_VERSION).toBe("0.152");
  });
});

withJava("decompileClass happy paths", () => {
  it("decompiles a class from a binary jar", async () => {
    const result = await decompileClass(newCacheDir(), COORDINATES, NOSOURCES_JAR, HIDDEN);
    const decompiled = asDecompiled(result);
    expect(decompiled.cached).toBe(false);
    expect(decompiled.source).toContain("class Hidden");
    expect(decompiled.source).toContain("secret");
    const parsed = parseJavaSource(decompiled.source, "Hidden.java");
    expect(parsed.classes.map((c) => c.fqn)).toContain("com.example.nosources.Hidden");
  });

  it("returns the cached source on the second call without invoking java", async () => {
    const cacheDir = newCacheDir();
    const first = asDecompiled(await decompileClass(cacheDir, COORDINATES, NOSOURCES_JAR, HIDDEN));
    const execSpy = vi.fn(async () => {
      throw new Error("exec must not be invoked on a cache hit");
    });
    const second = asDecompiled(
      await decompileClass(cacheDir, COORDINATES, NOSOURCES_JAR, HIDDEN, { exec: execSpy }),
    );
    expect(execSpy).not.toHaveBeenCalled();
    expect(second.cached).toBe(true);
    expect(second.source).toBe(first.source);
  });
});

describe("decompileClass failure modes", () => {
  it("degrades to no-jvm when java cannot be spawned", async () => {
    const exec = async () => {
      throw new SpawnError(
        "java",
        Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      );
    };
    const result = await decompileClass(newCacheDir(), COORDINATES, NOSOURCES_JAR, HIDDEN, { exec });
    expect(asSignature(result).reason).toBe("no-jvm");
  });

  it("degrades to cfr-failed with the stderr tail on a nonzero exit", async () => {
    const exec = async () => ({ stdout: "", stderr: "Analyzing the class\njava.lang.Exception: boom", code: 1 });
    const result = await decompileClass(newCacheDir(), COORDINATES, NOSOURCES_JAR, HIDDEN, { exec });
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    expect(signature.detail).toContain("Exception");
  });

  it("degrades to cfr-failed when the class entry is absent from the jar", async () => {
    const execSpy = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const result = await decompileClass(newCacheDir(), COORDINATES, NOSOURCES_JAR, "no/such/Thing", {
      exec: execSpy,
    });
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    expect(signature.detail).toBe("entry not found");
  });
});
