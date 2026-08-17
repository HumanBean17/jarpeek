import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { indexArtifacts, type IndexResult } from "../../src/index/indexer.js";
import { IndexStore } from "../../src/index/store.js";
import { computeDependencySetHash, readManifest } from "../../src/index/manifest.js";
import { listZipEntries, readZipEntry } from "../../src/parse/zip.js";
import type { Declaration, DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const JARS = join(FIXTURES, "jars");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const DEMO_BINARY_JAR = join(JARS, "demo-lib-1.0.0.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

/** Minimal single-entry stored zip — enough for the JDK-style sources fixture. */
function craftStoredZip(name: string, payload: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const size = payload.length;
  const lfh = Buffer.concat([
    u32(LFH_SIG),
    u16(20), // version needed
    u16(0), // flags
    u16(0), // method: stored
    u16(0), // time
    u16(0), // date
    u32(0), // crc (the reader does not verify)
    u32(size),
    u32(size),
    u16(nameBuf.length),
    u16(0), // extra length
    nameBuf,
  ]);
  const cdh = Buffer.concat([
    u32(CDH_SIG),
    u16(20), // version made by
    u16(20), // version needed
    u16(0), // flags
    u16(0), // method
    u16(0), // time
    u16(0), // date
    u32(0), // crc
    u32(size),
    u32(size),
    u16(nameBuf.length),
    u16(0), // extra length
    u16(0), // comment length
    u16(0), // disk number start
    u16(0), // internal attributes
    u32(0), // external attributes
    u32(0), // local header offset: the only entry starts at 0
    nameBuf,
  ]);
  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0), // this disk
    u16(0), // disk with central directory
    u16(1), // entries on this disk
    u16(1), // total entries
    u32(cdh.length),
    u32(lfh.length + size),
    u16(0), // comment length
  ]);
  return Buffer.concat([lfh, payload, cdh, eocd]);
}

const MOD_JAVA = [
  "package com.example;",
  "",
  "/** Module-side helper. */",
  "public class Mod {",
  "",
  "    /** Answers the module label. */",
  "    public String label() {",
  "        return \"mod\";",
  "    }",
  "}",
].join("\n");

const KT_HELPER_KT = ["package com.example", "", "/** Top-level helper surfaced through the file facade. */", "fun helper(): Int = 1"].join("\n");

const PRUNED_JAVA = "package com.example.build;\n\npublic class Generated {\n}\n";

const FAKE_JAVA = [
  "package java.util;",
  "",
  "/** JDK-style module-prefix fixture. */",
  "public class Fake {",
  "",
  "    /** Sizes the fake. */",
  "    public int size() {",
  "        return 1;",
  "    }",
  "}",
].join("\n");

interface Ctx {
  projectRoot: string;
  cacheRoot: string;
  store: IndexStore;
  progress: string[];
  result: IndexResult;
  classesDir: string;
}

const ctx = {} as Ctx;

beforeAll(async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-indexer-project-"));
  const cacheRoot = mkdtempSync(join(tmpdir(), "jarpeek-indexer-store-"));
  const store = new IndexStore(cacheRoot);
  const progress: string[] = [];

  // module source tree inside the project: Mod.java + KtHelper.kt, plus a
  // build/ subtree the walk must prune
  const pkgDir = join(projectRoot, "src/main/java/com/example");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "Mod.java"), MOD_JAVA);
  writeFileSync(join(pkgDir, "KtHelper.kt"), KT_HELPER_KT);
  mkdirSync(join(pkgDir, "build"), { recursive: true });
  writeFileSync(join(pkgDir, "build", "Generated.java"), PRUNED_JAVA);

  // classesDir fallback: the real Hidden.class bytes plus a corrupt entry and
  // a module-info.class that must be excluded outright
  const classesDir = join(projectRoot, "extracted-classes");
  const hiddenEntries = await listZipEntries(NOSOURCES_JAR);
  const hiddenEntry = hiddenEntries.find((e) => e.name === "com/example/nosources/Hidden.class");
  expect(hiddenEntry, "nosources fixture should carry Hidden.class").toBeDefined();
  mkdirSync(join(classesDir, "com/example/nosources"), { recursive: true });
  writeFileSync(
    join(classesDir, "com/example/nosources/Hidden.class"),
    await readZipEntry(NOSOURCES_JAR, hiddenEntry!),
  );
  writeFileSync(join(classesDir, "Bad.class"), "not a class file at all");
  writeFileSync(join(classesDir, "module-info.class"), "also not a class file");

  // JDK-style sources jar: the module prefix lives only in the entry path
  const jdkJar = join(projectRoot, "jdk-fake-sources.jar");
  writeFileSync(jdkJar, craftStoredZip("java.base/java/util/Fake.java", Buffer.from(FAKE_JAVA)));

  // corruption fixture: plain text renamed .jar
  const corruptJar = join(projectRoot, "corrupt-sources.jar");
  writeFileSync(corruptJar, "this is definitely not a zip archive");

  const artifacts: DependencyArtifact[] = [
    {
      coordinates: "com.example:demo-lib:1.0.0",
      kind: "external",
      sourcesJar: DEMO_SOURCES_JAR,
      provenance: "source",
      warnings: [],
    },
    {
      coordinates: "com.example:nosources-lib:1.0.0",
      kind: "external",
      binaryJar: NOSOURCES_JAR,
      provenance: "signature",
      warnings: [],
    },
    {
      coordinates: "com.example:demo-lib-bin:1.0.0",
      kind: "external",
      binaryJar: DEMO_BINARY_JAR,
      provenance: "signature",
      warnings: [],
    },
    {
      coordinates: "com.example:mod:1.0",
      kind: "module",
      sourceDir: join(projectRoot, "src/main/java"),
      binaryJar: DEMO_BINARY_JAR,
      provenance: "source",
      warnings: [],
    },
    {
      coordinates: "jdk:java.fake",
      kind: "jdk",
      sourcesJar: jdkJar,
      provenance: "source",
      warnings: [],
    },
    {
      coordinates: "com.example:corrupt:1.0.0",
      kind: "external",
      sourcesJar: corruptJar,
      provenance: "source",
      warnings: [],
    },
    {
      coordinates: "com.example:extracted:1.0.0",
      kind: "external",
      classesDir,
      provenance: "signature",
      warnings: [],
    },
    {
      coordinates: "com.example:nothing:1.0.0",
      kind: "external",
      provenance: "source",
      warnings: [],
    },
  ];

  const result = await indexArtifacts(projectRoot, artifacts, {
    store,
    onProgress: (msg) => progress.push(msg),
  });

  Object.assign(ctx, { projectRoot, cacheRoot, store, progress, result, classesDir });
});

afterAll(() => {
  rmSync(ctx.projectRoot, { recursive: true, force: true });
  rmSync(ctx.cacheRoot, { recursive: true, force: true });
});

function hitFor(fqn: string, coordinates: string) {
  return ctx.store.lookup(fqn).then((hits) => {
    const hit = hits.find((h) => h.meta.coordinates === coordinates);
    expect(hit, `${coordinates} should index ${fqn} (hits: ${hits.map((h) => h.meta.coordinates).join(", ")})`).toBeDefined();
    return hit!;
  });
}

describe("indexArtifacts", () => {
  it("sources jar: class and member records carry line ranges and provenance source", async () => {
    const hit = await hitFor("com.example.Demo", "com.example:demo-lib:1.0.0");
    expect(hit.meta.provenance).toBe("source");

    const classRecord = hit.records.find((r) => r.selector === "Demo" && r.kind === "class");
    expect(classRecord).toBeDefined();
    expect(classRecord!.visibility).toBe("public");
    expect(classRecord!.signature).toBe("public class Demo");
    expect(classRecord!.lineStart).toEqual(expect.any(Number));

    const run = hit.records.find((r) => r.selector === "run" && r.kind === "method");
    expect(run).toBeDefined();
    expect(run!.fqn).toBe("com.example.Demo");
    expect(run!.lineStart).toEqual(expect.any(Number));
    expect(run!.file).toBe("com/example/Demo.java");
  });

  it("binary jar: signature provenance, no line ranges, .class file names", async () => {
    const hit = await hitFor("com.example.nosources.Hidden", "com.example:nosources-lib:1.0.0");
    expect(hit.meta.provenance).toBe("signature");
    const classRecord = hit.records.find((r) => r.selector === "Hidden" && r.kind === "class");
    expect(classRecord).toBeDefined();
    expect(hit.records.some((r) => r.selector === "secret" && r.kind === "method")).toBe(true);
    for (const record of hit.records) {
      expect(record.lineStart).toBeUndefined();
      expect(record.file.endsWith(".class")).toBe(true);
    }
  });

  it("binary jar drops anonymous classes but keeps named nested ones", async () => {
    const anonymous = await ctx.store.lookup("com.example.Outer.1");
    expect(anonymous).toEqual([]);

    const nested = await hitFor("com.example.Demo.Worker", "com.example:demo-lib-bin:1.0.0");
    expect(nested.records.some((r) => r.selector === "work")).toBe(true);

    const demo = await hitFor("com.example.Demo", "com.example:demo-lib-bin:1.0.0");
    expect(demo.meta.provenance).toBe("signature");
    expect(demo.records.every((r) => r.lineStart === undefined)).toBe(true);
  });

  it("module sourceDir: repo-relative file, source wins over binaryJar, build/ pruned", async () => {
    const hit = await hitFor("com.example.Mod", "com.example:mod:1.0");
    expect(hit.meta.provenance).toBe("source");
    const classRecord = hit.records.find((r) => r.selector === "Mod" && r.kind === "class");
    expect(classRecord!.file).toBe("src/main/java/com/example/Mod.java");
    const label = hit.records.find((r) => r.selector === "label");
    expect(label).toBeDefined();
    expect(label!.lineStart).toEqual(expect.any(Number));

    const pruned = await ctx.store.lookup("com.example.build.Generated");
    expect(pruned).toEqual([]);
  });

  it("Kotlin facade classes flow through as regular class records", async () => {
    const hit = await hitFor("com.example.KtHelperKt", "com.example:mod:1.0");
    const classRecord = hit.records.find((r) => r.selector === "KtHelperKt" && r.kind === "class");
    expect(classRecord).toBeDefined();
    expect(classRecord!.file).toBe("src/main/java/com/example/KtHelper.kt");
    expect(hit.records.some((r) => r.selector === "helper" && r.kind === "method")).toBe(true);
  });

  it("JDK-style entries: fqn from the package statement, module prefix ignored", async () => {
    const hit = await hitFor("java.util.Fake", "jdk:java.fake");
    expect(hit.meta.provenance).toBe("source");
    const classRecord = hit.records.find((r) => r.selector === "Fake" && r.kind === "class");
    expect(classRecord).toBeDefined();
    expect(classRecord!.file).toBe("java.base/java/util/Fake.java");
    expect(hit.records.some((r) => r.selector === "size" && r.kind === "method")).toBe(true);
  });

  it("classesDir: binary treatment with per-entry degradation, module-info excluded", async () => {
    const hits = await ctx.store.lookup("com.example.nosources.Hidden");
    expect(hits.map((h) => h.meta.coordinates)).toEqual([
      "com.example:nosources-lib:1.0.0",
      "com.example:extracted:1.0.0",
    ]);
    const hit = hits[1]!;
    expect(hit.meta.provenance).toBe("signature");
    expect(hit.records.every((r) => r.lineStart === undefined)).toBe(true);
    expect(hit.records.every((r) => r.file.startsWith("com/") || r.file === "com")).toBe(true);

    expect(ctx.result.warnings.some((w) => w.startsWith("failed to index Bad.class:"))).toBe(true);
    expect(ctx.result.warnings.some((w) => w.includes("module-info"))).toBe(false);
  });

  it("corrupt sources jar degrades to a warning without aborting the run", () => {
    expect(ctx.result.indexed).toEqual([
      "com.example:demo-lib:1.0.0",
      "com.example:nosources-lib:1.0.0",
      "com.example:demo-lib-bin:1.0.0",
      "com.example:mod:1.0",
      "jdk:java.fake",
      "com.example:extracted:1.0.0",
    ]);
    expect(ctx.result.warnings.some((w) => w.startsWith("failed to index ") && w.includes("corrupt-sources.jar"))).toBe(true);
    expect(ctx.result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("artifacts without any source are skipped with a reason", () => {
    expect(ctx.result.skipped).toEqual([
      { coordinates: "com.example:nothing:1.0.0", reason: "no jar or source dir" },
    ]);
  });

  it("manifest is written with the dependency-set hash and updated warnings", async () => {
    const manifest = await readManifest(ctx.projectRoot);
    expect(manifest).not.toBeNull();
    expect(manifest!.version).toBe(1);
    expect(manifest!.dependencySetHash).toBe(await computeDependencySetHash(ctx.projectRoot));
    expect(manifest!.artifacts.map((a) => a.coordinates)).toEqual([
      "com.example:demo-lib:1.0.0",
      "com.example:nosources-lib:1.0.0",
      "com.example:demo-lib-bin:1.0.0",
      "com.example:mod:1.0",
      "jdk:java.fake",
      "com.example:corrupt:1.0.0",
      "com.example:extracted:1.0.0",
    ]);
    const corrupt = manifest!.artifacts.find((a) => a.coordinates === "com.example:corrupt:1.0.0");
    expect(corrupt!.warnings.some((w) => w.includes("corrupt-sources.jar"))).toBe(true);
  });

  it("onProgress receives at least one line per artifact", () => {
    expect(ctx.progress.length).toBeGreaterThanOrEqual(8);
    expect(ctx.progress.some((l) => /^indexing com\.example:demo-lib:1\.0\.0 \(source, [1-9]\d* files\)$/.test(l))).toBe(true);
    expect(ctx.progress.some((l) => l.startsWith("skipping com.example:nothing:1.0.0"))).toBe(true);
  });
});
