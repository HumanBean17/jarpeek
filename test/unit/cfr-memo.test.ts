/**
 * createDecompiler memo semantics: only successful decompiles are remembered
 * (keyed coordinates + internal name), and every failure recomputes — a JVM
 * appearing later in the process must be able to change the answer.
 *
 * exec is injected, so these run without a JVM: the jar reads and the
 * temp-dir round-trip are real, the CFR run is a fake.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDecompiler, type DecompileResult } from "../../src/decompile/cfr.js";
import { SpawnError, type RunResult } from "../../src/util/exec.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
// two real class entries so the memo can be proven per-class
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");
const COORDINATES = "com.example:demo-lib:1.0.0";

type Decompiled = Extract<DecompileResult, { provenance: "decompiled" }>;
type Signature = Extract<DecompileResult, { provenance: "signature" }>;

function asDecompiled(r: DecompileResult): Decompiled {
  if (r.provenance !== "decompiled") throw new Error(`expected decompiled, got ${JSON.stringify(r)}`);
  return r;
}

function asSignature(r: DecompileResult): Signature {
  if (r.provenance !== "signature") throw new Error(`expected signature, got ${JSON.stringify(r)}`);
  return r;
}

/** exec stub returning a minimal one-class source on stdout. */
function fakeExec(impl?: () => Promise<RunResult>) {
  return vi.fn(impl ?? (async (): Promise<RunResult> => ({ stdout: "class Demo {}\n", stderr: "", code: 0 })));
}

describe("createDecompiler memo", () => {
  it("first call decompiles via exec (cached: false)", async () => {
    const exec = fakeExec();
    const decompile = createDecompiler({ exec });
    const result = asDecompiled(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.source).toContain("class Demo");
  });

  it("second call for the same triple is a memo hit without invoking exec", async () => {
    const exec = fakeExec();
    const decompile = createDecompiler({ exec });
    const first = asDecompiled(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    const second = asDecompiled(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.source).toBe(first.source);
  });

  it("a different internalName misses the memo and decompiles again", async () => {
    const exec = fakeExec();
    const decompile = createDecompiler({ exec });
    await decompile(COORDINATES, DEMO_JAR, "com/example/Demo");
    asDecompiled(await decompile(COORDINATES, DEMO_JAR, "com/example/Point"));
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("a failing exec returns signature and is not memoized", async () => {
    const exec = fakeExec(async () => ({
      stdout: "",
      stderr: "java.lang.Exception: boom",
      code: 1,
    }));
    const decompile = createDecompiler({ exec });
    const first = asSignature(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    expect(first.reason).toBe("cfr-failed");
    expect(first.detail).toContain("Exception");
    const second = asSignature(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    expect(second.reason).toBe("cfr-failed");
    // recomputed on the second call: failures never enter the memo
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("a SpawnError degrades to no-jvm and is not memoized", async () => {
    const exec = fakeExec(() => {
      throw new SpawnError(
        "java",
        Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      );
    });
    const decompile = createDecompiler({ exec });
    const first = asSignature(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    expect(first.reason).toBe("no-jvm");
    const second = asSignature(await decompile(COORDINATES, DEMO_JAR, "com/example/Demo"));
    expect(second.reason).toBe("no-jvm");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
