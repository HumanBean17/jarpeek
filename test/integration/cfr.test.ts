import { afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CFR_VERSION, cfrJarPath, createDecompiler, type DecompileResult } from "../../src/decompile/cfr.js";
import { parseJavaSource } from "../../src/parse/java-lexer.js";
import { SpawnError } from "../../src/util/exec.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOSOURCES_JAR = join(FIXTURES, "jars", "nosources-lib-1.0.0.jar");
const HIDDEN = "com/example/nosources/Hidden";
const COORDINATES = "com.example:nosources-lib:1.0.0";

const tmpDirs: string[] = [];
function newTempDir(): string {
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

withJava("createDecompiler happy paths", () => {
  it("decompiles a class from a binary jar", async () => {
    const decompile = createDecompiler();
    const result = await decompile(COORDINATES, NOSOURCES_JAR, HIDDEN);
    const decompiled = asDecompiled(result);
    expect(decompiled.cached).toBe(false);
    expect(decompiled.source).toContain("class Hidden");
    expect(decompiled.source).toContain("secret");
    const parsed = parseJavaSource(decompiled.source, "Hidden.java");
    expect(parsed.classes.map((c) => c.fqn)).toContain("com.example.nosources.Hidden");
  });

  it("serves the memoized source on the second call (cached: true)", async () => {
    const decompile = createDecompiler();
    const first = asDecompiled(await decompile(COORDINATES, NOSOURCES_JAR, HIDDEN));
    const second = asDecompiled(await decompile(COORDINATES, NOSOURCES_JAR, HIDDEN));
    expect(second.cached).toBe(true);
    expect(second.source).toBe(first.source);
  });
});

describe("createDecompiler failure modes", () => {
  it("degrades to no-jvm when java cannot be spawned", async () => {
    const exec = async () => {
      throw new SpawnError(
        "java",
        Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      );
    };
    const result = await createDecompiler({ exec })(COORDINATES, NOSOURCES_JAR, HIDDEN);
    expect(asSignature(result).reason).toBe("no-jvm");
  });

  it("degrades to cfr-failed with the stderr tail on a nonzero exit", async () => {
    const exec = async () => ({ stdout: "", stderr: "Analyzing the class\njava.lang.Exception: boom", code: 1 });
    const result = await createDecompiler({ exec })(COORDINATES, NOSOURCES_JAR, HIDDEN);
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    expect(signature.detail).toContain("Exception");
  });

  it("degrades to cfr-failed when the class entry is absent from the jar", async () => {
    const execSpy = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const result = await createDecompiler({ exec: execSpy })(COORDINATES, NOSOURCES_JAR, "no/such/Thing");
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    expect(signature.detail).toBe("entry not found");
    expect(execSpy).not.toHaveBeenCalled();
  });

  // CFR exits 0 on an unloadable class and prints the failure to stderr; that
  // text mentions "class specified" and must never pass for decompiled source.
  it("rejects CFR failure text on stderr (exit 0) instead of decompiling it", async () => {
    const exec = async () => ({
      stdout: "",
      stderr:
        "Can't load the class specified:\n" +
        "org.benf.cfr.reader.util.CannotLoadClassException: Garbage.class - " +
        "org.benf.cfr.reader.util.ConfusedCFRException: Magic != Cafebabe for class file 'Garbage.class'",
      code: 0,
    });
    const result = await createDecompiler({ exec })(COORDINATES, NOSOURCES_JAR, HIDDEN);
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    expect(signature.detail).toContain("CannotLoadClassException");
  });

  it("accepts stderr as source when it is genuine decompiled Java", async () => {
    const exec = async () => ({
      stdout: "",
      stderr: "package x;\npublic class A {\n    public int size() {\n        return 1;\n    }\n}\n",
      code: 0,
    });
    const result = await createDecompiler({ exec })(COORDINATES, NOSOURCES_JAR, HIDDEN);
    const decompiled = asDecompiled(result);
    expect(decompiled.source).toContain("class A");
  });

  it("never serves output that parses to zero classes", async () => {
    // exit 0, stdout carries text that merely looks declarative but parses to
    // no class — the zero-class backstop must refuse to memoize or return it
    const execSpy = vi.fn(async () => ({
      stdout: "Can't load the class specified:\nMagic != Cafebabe for class file 'Garbage.class'\n",
      stderr: "",
      code: 0,
    }));
    const decompile = createDecompiler({ exec: execSpy });
    const result = await decompile(COORDINATES, NOSOURCES_JAR, HIDDEN);
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    // not memoized: a retry re-runs exec rather than serving the bad output
    await decompile(COORDINATES, NOSOURCES_JAR, HIDDEN);
    expect(execSpy).toHaveBeenCalledTimes(2);
  });
});

withJava("createDecompiler against the real CFR", () => {
  it("rejects a corrupt class file (exit 0, failure on stderr) without memoizing", async () => {
    const scratch = newTempDir();
    const garbageJar = join(scratch, "garbage.jar");
    // single-entry stored zip (same craft as the indexer tests) whose payload
    // is not a class file — CFR loads it, fails, and still exits 0
    const name = "garbage/Bad.class";
    const payload = Buffer.from("not a class file");
    const nameBuf = Buffer.from(name, "utf8");
    const u16 = (v: number) => Buffer.from(new Uint16Array([v]).buffer);
    const u32 = (v: number) => Buffer.from(new Uint32Array([v]).buffer);
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(payload.length), u32(payload.length), u16(nameBuf.length), u16(0), nameBuf,
    ]);
    const cdh = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(payload.length), u32(payload.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(0), nameBuf,
    ]);
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1),
      u32(cdh.length), u32(lfh.length + payload.length), u16(0),
    ]);
    writeFileSync(garbageJar, Buffer.concat([lfh, payload, cdh, eocd]));

    const decompile = createDecompiler();
    const result = await decompile("garbage:bad:1", garbageJar, "garbage/Bad");
    const signature = asSignature(result);
    expect(signature.reason).toBe("cfr-failed");
    expect(signature.detail).toContain("Can't load the class");
  });
});
