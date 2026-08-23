/**
 * Query-core integration: outline/readSource/readMember answering from
 * listings + one-file parses (Task 7's world).
 *
 * The manifest is written directly per suite (fixture-manifest world —
 * `writeManifest` with a matching `dependencySetHash` so `isStale` is false
 * and `ensureReady` serves it without resolving); find-class/search-symbols
 * still answer from the store until Tasks 8-9 and keep their own cases here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { outline, LookupMissError } from "../../src/core/query/outline.js";
import { readMember } from "../../src/core/query/read-member.js";
import { readSource } from "../../src/core/query/read-source.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import { splitLines } from "../../src/util/lines.js";
import { listZipEntries, readTextEntry } from "../../src/parse/zip.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const JARS = join(FIXTURES, "jars");
const DEMO_BINARY_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

/** Minimal self-named class file (big-endian fields) with one public method. */
function craftClassFile(binaryName: string, methodName: string): Buffer {
  const u8 = (v: number): Buffer => Buffer.from([v]);
  const u16be = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    return b;
  };
  const u32be = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
  };
  const utf8Const = (s: string): Buffer => {
    const bytes = Buffer.from(s, "utf8");
    return Buffer.concat([u8(1), u16be(bytes.length), bytes]);
  };
  const classConst = (nameIndex: number): Buffer => Buffer.concat([u8(7), u16be(nameIndex)]);
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
    u16be(0), // interfaces
    u16be(0), // fields
    u16be(1), // methods
    u16be(0x0001), // public
    u16be(5), // name
    u16be(6), // descriptor
    u16be(0), // method attributes
    u16be(0), // class attributes
  ]);
}

/** Stored (uncompressed) multi-entry zip — locate parses real entry bytes. */
function craftStoredZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const u16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    const cdh = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]);
    locals.push(lfh, data);
    centrals.push(cdh);
    offset += lfh.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-query7-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Open a context over a manifest written BEFORE construction (fresh, non-stale). */
async function contextWith(artifacts: DependencyArtifact[]): Promise<QueryContext> {
  const projectRoot = freshRoot();
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  await writeManifest(projectRoot, {
    version: 2,
    resolvedAt: "",
    dependencySetHash: await computeDependencySetHash(projectRoot),
    artifacts,
  });
  // resolvers stubbed to fail-and-degrade: the stale-index suites bootstrap
  // after making their manifests stale, and the REAL cascade's duration is a
  // fact about the host (windows CI images ship Gradle — a cold daemon runs
  // past every test timeout). Degrade-to-cache-scan instantly, serve stale —
  // the behavior under test.
  return openContext(projectRoot, {
    onNotice: () => {},
    resolvers: {
      gradle: async () => ({ ok: false, artifacts: [], reason: "no-wrapper-no-gradle" }),
      maven: async () => ({ ok: false, artifacts: [], reason: "no-classpath" }),
      cacheScan: async () => ({ artifacts: [], warnings: [] }),
      includeJdk: false,
    },
  });
}

async function demoSource(): Promise<string> {
  const entries = await listZipEntries(DEMO_SOURCES_JAR);
  const entry = entries.find((e) => e.name === "com/example/Demo.java");
  expect(entry, "demo sources jar should carry Demo.java").toBeDefined();
  return readTextEntry(DEMO_SOURCES_JAR, entry!);
}

describe("outline from listings", () => {
  let ctx: QueryContext;
  beforeAll(async () => {
    ctx = await contextWith([
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
    ]);
  });

  it("returns the class row + members from the sources jar (scenario 1)", async () => {
    const result = await outline(ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    expect(result.stale).toBeUndefined();

    const selectors = result.rows.map((r) => r.selector);
    expect(selectors).toContain("run");
    expect(selectors).toContain("NAME");
    expect(result.rows.some((r) => r.selector === "run" && r.kind === "method")).toBe(true);
    expect(result.rows.some((r) => r.selector === "NAME" && r.kind === "field")).toBe(true);
    // the fixture's nested Worker surfaces as one class-kind row
    expect(result.rows.some((r) => r.selector === "Worker" && r.kind === "class")).toBe(true);
  });

  it("kind filter excludes other kinds", async () => {
    const result = await outline(ctx, "com.example.Demo", { kind: "method" });
    expect(result.rows.some((r) => r.selector === "NAME")).toBe(false);
    expect(result.rows.every((r) => r.kind === "method")).toBe(true);
  });

  it("visibility filter keeps only private members", async () => {
    const result = await outline(ctx, "com.example.Demo", { visibility: "private" });
    expect(result.rows.map((r) => r.selector)).toEqual(["NAME"]);
  });

  it("a DOTTED nested query hits the binary `Outer$Inner` entry (canonical fqn rule)", async () => {
    // temp jar: the query layer speaks dotted fqns; listings keep `$`
    const dir = freshRoot();
    const jar = join(dir, "nested.jar");
    writeFileSync(
      jar,
      craftStoredZip([
        { name: "a/b/Outer.class", data: craftClassFile("a/b/Outer", "dispatch") },
        { name: "a/b/Outer$Inner.class", data: craftClassFile("a/b/Outer$Inner", "describe") },
      ]),
    );
    const dotted = await contextWith([
      { coordinates: "test:nested:1", kind: "external", binaryJar: jar },
    ]);
    const result = await outline(dotted, "a.b.Outer.Inner");
    expect(result.coordinates).toBe("test:nested:1");
    expect(result.provenance).toBe("signature");
    expect(result.rows.some((r) => r.fqn === "a.b.Outer.Inner" && r.selector === "Inner")).toBe(true);
    expect(result.rows.some((r) => r.selector === "describe" && r.kind === "method")).toBe(true);
  });

  it("nested-class rows appear for a binary artifact (scenario 2)", async () => {
    const dir = freshRoot();
    const jar = join(dir, "nested.jar");
    writeFileSync(
      jar,
      craftStoredZip([
        { name: "a/b/Outer.class", data: craftClassFile("a/b/Outer", "dispatch") },
        { name: "a/b/Outer$Inner.class", data: craftClassFile("a/b/Outer$Inner", "describe") },
        { name: "a/b/Outer$1.class", data: craftClassFile("a/b/Outer$1", "run") },
      ]),
    );
    const ctx2 = await contextWith([
      { coordinates: "test:nested:1", kind: "external", binaryJar: jar },
    ]);
    const result = await outline(ctx2, "a.b.Outer");
    expect(result.provenance).toBe("signature");
    expect(result.rows.some((r) => r.fqn === "a.b.Outer" && r.selector === "Outer")).toBe(true);
    expect(result.rows.some((r) => r.fqn === "a.b.Outer" && r.selector === "dispatch")).toBe(true);
    // one class-kind row for the nested class; the anonymous one never surfaces
    expect(result.rows.some((r) => r.fqn === "a.b.Outer.Inner" && r.kind === "class")).toBe(true);
    expect(result.rows.some((r) => r.fqn === "a.b.Outer.1")).toBe(false);
  });

  it("an unreadable artifact does not fail outline and surfaces the aggregated degraded string (scenario 7)", async () => {
    const dir = freshRoot();
    const broken = join(dir, "broken.jar");
    writeFileSync(broken, "not a zip, just text padding to a plausible size");
    const ctx2 = await contextWith([
      { coordinates: "test:broken:1", kind: "external", binaryJar: broken },
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
    ]);
    const result = await outline(ctx2, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.rows.map((r) => r.selector)).toContain("run");
    expect(result.degraded).toContain("1 artifacts unreadable (test:broken:1)");
  });
});

describe("outline sections (presets + toggles)", () => {
  let ctx: QueryContext;
  beforeAll(async () => {
    ctx = await contextWith([
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
    ]);
  });

  it("serves the file's imports by default", async () => {
    const result = await outline(ctx, "com.example.Demo");
    expect(result.imports).toEqual(["import java.util.List;"]);
  });

  it("fields:false drops field/property/enum-constant rows but keeps the class row and methods", async () => {
    const result = await outline(ctx, "com.example.Demo", { sections: { fields: false } });
    expect(result.imports).toEqual(["import java.util.List;"]); // untouched section
    expect(result.rows.some((r) => r.kind === "field")).toBe(false);
    expect(result.rows.some((r) => r.selector === "Demo" && r.kind === "class")).toBe(true);
    expect(result.rows.some((r) => r.selector === "run" && r.kind === "method")).toBe(true);
    // constructors are method-section members: they survive fields:false…
    const point = await outline(ctx, "com.example.Point", { sections: { fields: false } });
    expect(point.rows.some((r) => r.kind === "constructor")).toBe(true);
    // …enum-constant rows are field-section members: they die under fields:false
    const colors = await outline(ctx, "com.example.Colors", { sections: { fields: false } });
    expect(colors.rows.some((r) => r.kind === "enum-constant")).toBe(false);
  });

  it("methods:false drops method and constructor rows", async () => {
    const result = await outline(ctx, "com.example.Point", { sections: { methods: false } });
    expect(result.rows.some((r) => r.kind === "method" || r.kind === "constructor")).toBe(false);
    expect(result.rows.some((r) => r.selector === "Point" && r.kind === "record")).toBe(true);
  });

  it("inner:false drops every row that is not the target's own", async () => {
    const result = await outline(ctx, "com.example.Demo", { sections: { inner: false } });
    expect(result.rows.every((r) => r.fqn === "com.example.Demo")).toBe(true);
    expect(result.rows.some((r) => r.selector === "work")).toBe(false);
  });

  it("javadoc:false strips the javadoc property from rows at data level", async () => {
    const withDoc = await outline(ctx, "com.example.Demo");
    expect(withDoc.rows.some((r) => r.javadoc !== undefined)).toBe(true);
    const stripped = await outline(ctx, "com.example.Demo", { sections: { javadoc: false } });
    expect(stripped.rows.every((r) => r.javadoc === undefined)).toBe(true);
  });

  it("preset minimal = no imports, no fields, no javadoc in one result", async () => {
    const result = await outline(ctx, "com.example.Demo", { preset: "minimal" });
    expect(result.imports).toBeUndefined();
    expect(result.rows.some((r) => r.kind === "field")).toBe(false);
    expect(result.rows.every((r) => r.javadoc === undefined)).toBe(true);
    // methods and inner classes stay: the frugal-first look
    expect(result.rows.some((r) => r.selector === "run" && r.kind === "method")).toBe(true);
    expect(result.rows.some((r) => r.selector === "Worker" && r.kind === "class")).toBe(true);
  });

  it("imports stay absent when the section is on but the winner carried none (binary)", async () => {
    const dir = freshRoot();
    const jar = join(dir, "bare.jar");
    writeFileSync(
      jar,
      craftStoredZip([
        { name: "a/b/Outer.class", data: craftClassFile("a/b/Outer", "dispatch") },
      ]),
    );
    const ctx2 = await contextWith([
      { coordinates: "test:bare:1", kind: "external", binaryJar: jar },
    ]);
    const result = await outline(ctx2, "a.b.Outer");
    expect(result.imports).toBeUndefined();
  });
});

describe("readMember / readSource from listings", () => {
  let ctx: QueryContext;
  beforeAll(async () => {
    ctx = await contextWith([
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
    ]);
  });

  it("readMember on the sources artifact returns line-numbered slices (scenario 3)", async () => {
    const result = await readMember(ctx, "com.example.Demo", "#run(String,int),#NAME");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    expect(result.members).toHaveLength(2);

    const run = result.members.find((m) => m.selector === "run(String,int)")!;
    expect(run.startLine).toBe(13); // javadocStart from the Task 4 golden
    expect(run.endLine).toBe(23);
    expect(run.javadoc).toBeDefined();
    expect(run.javadoc![0]!.trim()).toBe("/**");
    expect(run.lines.join("\n")).toContain("public Object run(String input, int count) throws Exception {");

    const name = result.members.find((m) => m.selector === "NAME")!;
    expect(name.startLine).toBe(11);
    expect(name.lines).toEqual(['    private static final String NAME = "demo";']);
    expect(result.misses).toEqual([]);
  });

  it("readMember on binary-only without a JVM decompile returns signature pseudo-members (scenario 4)", async () => {
    const binary = await contextWith([
      { coordinates: "com.example:nosources-lib:1.0.0", kind: "external", binaryJar: NOSOURCES_JAR },
    ]);
    // force a real spawn failure: PATH and JAVA_HOME point at an empty dir
    const emptyBin = freshRoot();
    const prevPath = process.env.PATH;
    const prevJavaHome = process.env.JAVA_HOME;
    process.env.PATH = emptyBin;
    process.env.JAVA_HOME = emptyBin;
    try {
      const result = await readMember(binary, "com.example.nosources.Hidden", "#secret()");
      expect(result.provenance).toBe("signature");
      expect(result.members).toHaveLength(1);
      const member = result.members[0]!;
      expect(member.selector).toBe("secret()");
      expect(member.lines).toEqual([member.signature]);
      expect(member.startLine).toBe(0);
      expect(result.misses).toEqual([
        { selector: "#secret()", reason: "no-jvm (decompile unavailable)" },
      ]);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = prevJavaHome;
    }
  });

  it("readSource with no options defaults to full source", async () => {
    const result = await readSource(ctx, "com.example.Demo");
    expect(result.mode).toBe("full");
    if (result.mode === "full") {
      expect(result.content).toContain("public Object run(String input, int count) throws Exception {");
      expect(result.lineCount).toBeGreaterThan(50);
    }
  });

  it("readSource full from a sources jar serves the exact fixture entry", async () => {
    const fixture = await demoSource();
    const result = await readSource(ctx, "com.example.Demo", { mode: "full" });
    expect(result.mode).toBe("full");
    expect(result.provenance).toBe("source");
    expect(result.content).toBe(fixture);
    expect(result.file).toBe("com/example/Demo.java");
    expect(result.startLine).toBe(1);
    expect(result.lineCount).toBe(splitLines(fixture).length);
    expect(result.lineCount).toBeGreaterThan(50);
  });

  it("readSource full from a sourceDir artifact reads the on-disk file (scenario 5)", async () => {
    const dir = freshRoot();
    mkdirSync(join(dir, "com", "mod"), { recursive: true });
    writeFileSync(
      join(dir, "com", "mod", "Svc.java"),
      "package com.mod;\n\npublic class Svc {\n  public int size() { return 1; }\n}\n",
    );
    const ctx2 = await contextWith([
      { coordinates: ":app", kind: "module", sourceDir: dir },
    ]);
    const full = await readSource(ctx2, "com.mod.Svc", { mode: "full" });
    expect(full.provenance).toBe("source");
    expect(full.file).toBe("com/mod/Svc.java");
    expect(full.content).toContain("public int size() { return 1; }");
    const member = await readMember(ctx2, "com.mod.Svc", "#size()");
    expect(member.members[0]!.startLine).toBe(4);
  });

  it("lines mode slices and reports clamping", async () => {
    const fixture = await demoSource();
    const all = splitLines(fixture);

    const sliced = await readSource(ctx, "com.example.Demo", { mode: "lines", from: 2, to: 4 });
    expect(sliced.mode).toBe("lines");
    expect(sliced.lines).toEqual(all.slice(1, 4));
    expect(sliced.startLine).toBe(2);
    expect(sliced.endLine).toBe(4);
    expect(sliced.clamped).toBe(false);

    const clamped = await readSource(ctx, "com.example.Demo", { mode: "lines", from: 999, to: 1000 });
    expect(clamped.mode).toBe("lines");
    expect(clamped.clamped).toBe(true);
    expect(clamped.lines).toEqual([]);
  });

  it("readSource full on a big source file reports lineCount over 100", async () => {
    const result = await readSource(ctx, "com.example.BigService", { mode: "full" });
    expect(result.lineCount).toBeGreaterThan(100);
  });

  it("lookup miss throws LookupMissError carrying the fqn", async () => {
    const err = await outline(ctx, "com.example.Missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupMissError);
    expect((err as Error).name).toBe("LookupMissError");
    expect((err as LookupMissError).fqn).toBe("com.example.Missing");
  });
});

describe("both-backings artifacts (the real Gradle/Maven shape)", () => {
  // binaryJar + sourcesJar of the same classes: hit-testing keeps binary
  // coverage, but the winner PARSES from the sources jar per the spec's
  // provenance ladder — outline/readSource serve source text with line
  // numbers, never bytecode/decompile output
  let ctx: QueryContext;
  beforeAll(async () => {
    ctx = await contextWith([
      {
        coordinates: "com.example:demo-lib:1.0.0",
        kind: "external",
        binaryJar: DEMO_BINARY_JAR,
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ]);
  });

  it("outline returns provenance source with line numbers from the sources jar", async () => {
    const result = await outline(ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    const run = result.rows.find((r) => r.selector === "run" && r.kind === "method")!;
    expect(run.lineStart).toBe(21); // the source file's line, not a decompile's
    expect(result.rows.some((r) => r.selector === "Worker" && r.kind === "class")).toBe(true);
  });

  it("readSource --full serves the sources jar entry verbatim", async () => {
    const result = await readSource(ctx, "com.example.Demo", { mode: "full" });
    expect(result.provenance).toBe("source");
    expect(result.file).toBe("com/example/Demo.java");
    expect(result.lineCount).toBeGreaterThan(50);
    expect(result.content).toContain('private static final String NAME = "demo";');
  });

  it("readMember slices carry the source file's line spans", async () => {
    const result = await readMember(ctx, "com.example.Demo", "#run(String,int)");
    expect(result.provenance).toBe("source");
    expect(result.members[0]!.startLine).toBe(13);
    expect(result.members[0]!.javadoc).toBeDefined();
  });
});

describe("collisions (manifest order)", () => {
  it("two manifest artifacts listing the same fqn: winner + alternatives (scenario 6)", async () => {
    const dupDir = freshRoot();
    mkdirSync(join(dupDir, "com", "example"), { recursive: true });
    writeFileSync(
      join(dupDir, "com", "example", "Demo.java"),
      "package com.example;\n\npublic class Demo {}\n",
    );
    const ctx = await contextWith([
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
      { coordinates: "com.other:dup:1", kind: "external", sourceDir: dupDir },
    ]);

    const result = await outline(ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.alternatives).toContainEqual({ coordinates: "com.other:dup:1" });

    const member = await readMember(ctx, "com.example.Demo", "#run");
    expect(member.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(member.members.length).toBeGreaterThan(0);
    expect(member.alternatives).toContainEqual({ coordinates: "com.other:dup:1" });
  });
});

describe("stale index served", () => {
  // runs the failing resolve cascade (gradle/maven probes) after the build
  // file moves — CI runners need headroom past the 30s default (timed out
  // on contended runners twice)
  it("a stale manifest is served flagged with stale: true and a degraded entry", { timeout: 90_000 }, async () => {
    const ctx = await contextWith([
      { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
    ]);
    await outline(ctx, "com.example.Demo"); // served fresh once
    // build file moves AFTER the manifest: staleness, but no resolver wired —
    // the failing default cascade leaves the manifest served stale
    const projectRoot = ctx.projectRoot;
    writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n// moved\n");
    const result = await outline(ctx, "com.example.Demo");
    expect(result.stale).toBe(true);
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.rows.map((r) => r.selector)).toContain("run");
    expect(result.degraded.some((d) => d.includes("stale"))).toBe(true);
  });
});
