import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ListingService } from "../../src/core/listing.js";
import { classFamily, locateClass, type LocateDeps } from "../../src/core/query/locate.js";
import { LookupMissError } from "../../src/core/query/outline.js";
import type { DependencyArtifact } from "../../src/core/types.js";
import type { Manifest } from "../../src/index/manifest.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");
const SOURCES_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(FIXTURES, "jars", "nosources-lib-1.0.0.jar");

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

function u8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v);
  return b;
}

/** Big-endian u16/u32 — class files are big-endian, unlike the zip fields above. */
function u16be(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
}
function u32be(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
}

const utf8Const = (s: string): Buffer => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u8(1), u16be(bytes.length), bytes]);
};
const classConst = (nameIndex: number): Buffer => Buffer.concat([u8(7), u16be(nameIndex)]);

/**
 * Minimal well-formed class file naming itself `binaryName` with one public
 * method — locate parses entry bytes, so renamed fixture bytes would
 * self-identify under their OLD name and never match the located fqn.
 */
function craftClassFile(binaryName: string, methodName: string): Buffer {
  const pool: Buffer[] = [
    utf8Const(binaryName), // 1
    classConst(1), // 2 this
    utf8Const("java/lang/Object"), // 3
    classConst(3), // 4 super
    utf8Const(methodName), // 5
    utf8Const("()I"), // 6
  ];
  return Buffer.concat([
    u32be(0xcafebabe),
    u16be(0), // minor
    u16be(52), // major
    u16be(pool.length + 1), // constant-pool count
    ...pool,
    u16be(0x0021), // ACC_PUBLIC | ACC_SUPER
    u16be(2), // this_class
    u16be(4), // super_class
    u16be(0), // interfaces count
    u16be(0), // fields count
    u16be(1), // methods count
    u16be(0x0001), // public
    u16be(5), // name → methodName
    u16be(6), // descriptor → ()I
    u16be(0), // method attribute count
    u16be(0), // class attribute count
  ]);
}

/**
 * Assemble a stored multi-entry zip by hand with REAL payloads — unlike the
 * listing fixture helper (1-byte dummies), locate parses entry bytes, so
 * class entries must carry actual class-file data. crc32 stays 0: the zip
 * reader validates sizes, never checksums.
 */
function craftZip(files: Array<{ name: string; data: string | Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const size = payload.length;
    const lfh = Buffer.concat([
      u32(LFH_SIG),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0), // time
      u16(0), // date
      u32(0), // crc
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
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
      u16(nameBytes.length),
      u16(0), // extra length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal attributes
      u32(0), // external attributes
      u32(offset),
      nameBytes,
    ]);
    locals.push(lfh, payload);
    centrals.push(cdh);
    offset += lfh.length + size;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0), // this disk
    u16(0), // disk with central directory
    u16(files.length), // entries on this disk
    u16(files.length), // total entries
    u32(cd.length),
    u32(offset),
    u16(0), // comment length
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Fresh temp dir the test removes in its finally block. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-locate-"));
}

/** Minimal artifact literal; locate reads only the coordinates and backing paths. */
function artifact(
  fields: Pick<DependencyArtifact, "coordinates"> & Partial<DependencyArtifact>,
): DependencyArtifact {
  return { kind: "external", provenance: "signature", warnings: [], ...fields };
}

/** Hand-built LocateDeps: a real ListingService over the given artifacts plus a manifest literal. */
function deps(artifacts: DependencyArtifact[]): LocateDeps {
  const manifest: Manifest = { version: 1, resolvedAt: "", dependencySetHash: "", artifacts };
  return { listings: new ListingService(), manifest: async () => manifest };
}

const DEMO_SOURCES = artifact({ coordinates: "com.example:demo-lib:1.0.0", sourcesJar: SOURCES_JAR });

describe("locateClass", () => {
  it("locates a class in a sources jar with its class row, members, and nested rows", async () => {
    const result = await locateClass(deps([DEMO_SOURCES]), "com.example.Demo");
    expect(result.winner.provenance).toBe("source");
    expect(result.winner.entry).toBe("com/example/Demo.java");
    const records = result.winner.records;
    const classRow = records.find((r) => r.fqn === "com.example.Demo" && r.kind === "class")!;
    expect(classRow.selector).toBe("Demo");
    expect(classRow.lineStart).toBeGreaterThan(0); // source rows carry line ranges
    expect(records.some((r) => r.selector === "run" && r.kind === "method")).toBe(true);
    expect(records.some((r) => r.selector === "old" && r.kind === "method" && r.deprecated)).toBe(true);
    expect(records.some((r) => r.selector === "NAME" && r.kind === "field")).toBe(true);
    // includeNested: the lexer's dot-separated Worker class row, members excluded
    const worker = records.filter((r) => r.fqn === "com.example.Demo.Worker");
    expect(worker).toHaveLength(1);
    expect(worker[0]!.kind).toBe("class");
    expect(result.alternatives).toEqual([]);
    expect(result.degraded).toEqual([]);
  });

  it("a DOTTED nested query hits a binary listing's `Outer$Inner` entry (canonical fqn rule)", async () => {
    const dir = tempDir();
    try {
      // the query layer speaks dotted fqns; listings keep `$` internally, so
      // the dotted query must match the ClassEntry via $→. equivalence
      const jar = join(dir, "dotted.jar");
      writeFileSync(
        jar,
        craftZip([
          { name: "a/b/Outer.class", data: craftClassFile("a/b/Outer", "dispatch") },
          { name: "a/b/Outer$Inner.class", data: craftClassFile("a/b/Outer$Inner", "describe") },
        ]),
      );
      const d = deps([artifact({ coordinates: "test:dotted:1", binaryJar: jar })]);
      const result = await locateClass(d, "a.b.Outer.Inner");
      expect(result.winner.entry).toBe("a/b/Outer$Inner.class");
      expect(result.winner.records.some((r) => r.fqn === "a.b.Outer.Inner" && r.kind === "class")).toBe(true);
      // the class-file reader maps $ to ., so the own row matches the dotted query
      expect(result.winner.records.some((r) => r.selector === "describe" && r.kind === "method")).toBe(true);
      expect(result.degraded).toEqual([]);

      // the `$`-spelled query means the same class after normalization
      const dollar = await locateClass(d, "a.b.Outer$Inner");
      expect(dollar.winner.entry).toBe("a/b/Outer$Inner.class");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locates a class in a binary jar as signature provenance without line numbers", async () => {
    const d = deps([
      artifact({ coordinates: "com.example:nosources-lib:1.0.0", binaryJar: NOSOURCES_JAR }),
    ]);
    const result = await locateClass(d, "com.example.nosources.Hidden");
    expect(result.winner.provenance).toBe("signature");
    expect(result.winner.entry).toBe("com/example/nosources/Hidden.class");
    expect(result.winner.records.some((r) => r.kind === "class" && r.selector === "Hidden")).toBe(true);
    expect(result.winner.records.some((r) => r.selector === "secret" && r.kind === "method")).toBe(true);
    expect(result.winner.records.every((r) => r.lineStart === undefined)).toBe(true);
  });

  it("keeps the first manifest artifact as winner and later hits as alternatives", async () => {
    const d = deps([
      artifact({ coordinates: "test:first:1", sourcesJar: SOURCES_JAR }),
      artifact({ coordinates: "test:second:1", binaryJar: DEMO_JAR }),
    ]);
    const result = await locateClass(d, "com.example.Demo");
    expect(result.winner.artifact.coordinates).toBe("test:first:1");
    expect(result.winner.provenance).toBe("source");
    expect(result.alternatives).toEqual([{ coordinates: "test:second:1" }]);
  });

  it("throws LookupMissError when no artifact declares the fqn", async () => {
    const miss = await locateClass(deps([DEMO_SOURCES]), "com.example.Nope").catch((e) => e);
    expect(miss).toBeInstanceOf(LookupMissError);
    expect((miss as LookupMissError).fqn).toBe("com.example.Nope");
  });

  it("adds one class-kind row per directly nested binary class, skipping anonymous ones", async () => {
    const dir = tempDir();
    try {
      // self-named class bytes: a renamed fixture entry would parse under its
      // OLD name and never match the located fqn
      const jar = join(dir, "nested.jar");
      writeFileSync(
        jar,
        craftZip([
          { name: "a/b/Outer.class", data: craftClassFile("a/b/Outer", "dispatch") },
          { name: "a/b/Outer$Inner.class", data: craftClassFile("a/b/Outer$Inner", "describe") },
          { name: "a/b/Outer$1.class", data: craftClassFile("a/b/Outer$1", "run") },
        ]),
      );
      const d = deps([artifact({ coordinates: "test:nested:1", binaryJar: jar })]);
      const result = await locateClass(d, "a.b.Outer");
      expect(result.winner.entry).toBe("a/b/Outer.class");
      expect(result.winner.records.some((r) => r.fqn === "a.b.Outer" && r.kind === "class")).toBe(true);
      expect(result.winner.records.some((r) => r.selector === "dispatch" && r.kind === "method")).toBe(true);
      // the class-file reader maps $ to ., so the nested row arrives dot-separated
      const nested = result.winner.records.filter((r) => r.fqn === "a.b.Outer.Inner");
      expect(nested).toHaveLength(1);
      expect(nested[0]!.kind).toBe("class");
      expect(result.winner.records.some((r) => r.fqn === "a.b.Outer.1")).toBe(false);
      expect(result.degraded).toEqual([]);
      const bare = await locateClass(d, "a.b.Outer", { includeNested: false });
      expect(bare.winner.records.some((r) => r.fqn === "a.b.Outer.Inner")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aggregates unreadable artifacts while a good artifact still wins", async () => {
    const dir = tempDir();
    try {
      const broken = join(dir, "broken.jar");
      writeFileSync(broken, "not a zip, just text padding to a plausible size");
      const d = deps([
        artifact({ coordinates: "test:broken:1", binaryJar: broken }),
        DEMO_SOURCES,
      ]);
      const result = await locateClass(d, "com.example.Demo");
      expect(result.winner.artifact.coordinates).toBe("com.example:demo-lib:1.0.0");
      expect(result.degraded).toEqual(["1 artifacts unreadable (test:broken:1)"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locates a class in a sourceDir backing by exact relpath", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "com/example"), { recursive: true });
      writeFileSync(
        join(dir, "com/example/Demo.java"),
        "package com.example;\npublic class Demo {\n  public int size() { return 1; }\n}\n",
      );
      const result = await locateClass(
        deps([artifact({ coordinates: "test:module:1", sourceDir: dir })]),
        "com.example.Demo",
      );
      expect(result.winner.provenance).toBe("source");
      expect(result.winner.entry).toBe("com/example/Demo.java");
      expect(result.winner.records.some((r) => r.selector === "size" && r.kind === "method")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("degrades with an aggregated count when the winning entry fails to lex", async () => {
    const dir = tempDir();
    try {
      // unbalanced braces: the lexer never throws, it diagnoses — the
      // diagnostics channel is the lex-failure path locate aggregates
      const jar = join(dir, "broken-src.jar");
      writeFileSync(
        jar,
        craftZip([
          { name: "com/example/Demo.java", data: "package com.example;\npublic class Demo {\n" },
        ]),
      );
      const result = await locateClass(
        deps([artifact({ coordinates: "test:lexfail:1", sourcesJar: jar })]),
        "com.example.Demo",
      );
      expect(result.winner.entry).toBe("com/example/Demo.java");
      expect(result.degraded).toEqual(["1 entries failed to parse"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hits a unique suffix-matching sources entry and treats ambiguity as a miss", async () => {
    const dir = tempDir();
    try {
      const body = "package com.example;\npublic class Demo {}\n";
      const relocated = join(dir, "relocated.jar");
      writeFileSync(relocated, craftZip([{ name: "sources/root/com/example/Demo.java", data: body }]));
      const hit = await locateClass(
        deps([artifact({ coordinates: "test:reloc:1", sourcesJar: relocated })]),
        "com.example.Demo",
      );
      expect(hit.winner.entry).toBe("sources/root/com/example/Demo.java");

      const ambiguous = join(dir, "ambiguous.jar");
      writeFileSync(
        ambiguous,
        craftZip([
          { name: "one/com/example/Demo.java", data: body },
          { name: "two/com/example/Demo.java", data: body },
        ]),
      );
      const miss = await locateClass(
        deps([artifact({ coordinates: "test:ambig:1", sourcesJar: ambiguous })]),
        "com.example.Demo",
      ).catch((e) => e);
      expect(miss).toBeInstanceOf(LookupMissError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classFamily", () => {
  it("matches equality and nesting via either separator", () => {
    expect(classFamily("a.b.Outer.Inner", "a.b.Outer")).toBe(true);
    expect(classFamily("a.b.Outer$Inner", "a.b.Outer")).toBe(true);
    expect(classFamily("a.b.OuterX", "a.b.Outer")).toBe(false);
    expect(classFamily("a.b.Outer", "a.b.Outer")).toBe(true);
    // direct-or-deeper: a grandchild still belongs to the family
    expect(classFamily("a.b.Outer.Inner.Deep", "a.b.Outer")).toBe(true);
    expect(classFamily("a.b.Other.Inner", "a.b.Outer")).toBe(false);
  });
});
