/**
 * findClass over listings (Task 8's world): the manifest's artifacts are
 * listed in order — no store streaming — and the returned hits are refined
 * for kind (one parse per distinct hit, capped) and provenance (the promise
 * ladder: source backing → source; binary backing + JVM → decompiled; else
 * signature). The JVM question is injected (`opts.jvm`) so provenance never
 * spawns in a unit test.
 *
 * Harness: temp project dir + manifest written BEFORE openContext with a
 * matching dependencySetHash (the Task 7 pattern), so ensureReady serves it
 * without resolving. The round-trip property closes the loop: every hit's
 * dotted fqn maps onto a real entry of its artifact's jar.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { findClass } from "../../src/core/query/find-class.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import { listZipEntries } from "../../src/parse/zip.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const JARS = join(FIXTURES, "jars");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
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
function u8(v: number): Buffer {
  return Buffer.from([v]);
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
 * Minimal well-formed class file naming itself `binaryName` — kind refinement
 * parses entry bytes, so renamed fixture bytes would self-identify under their
 * OLD name and never match the hit's fqn. `interface` flags (0x0200) make the
 * fixture an interface; plain 0x0021 is a public class.
 */
function craftClassFile(binaryName: string, flags = 0x0021): Buffer {
  const pool: Buffer[] = [
    utf8Const(binaryName), // 1
    classConst(1), // 2 this
    utf8Const("java/lang/Object"), // 3
    classConst(3), // 4 super
  ];
  return Buffer.concat([
    u32be(0xcafebabe),
    u16be(0), // minor
    u16be(52), // major
    u16be(pool.length + 1), // constant-pool count
    ...pool,
    u16be(flags),
    u16be(2), // this_class
    u16be(4), // super_class
    u16be(0), // interfaces count
    u16be(0), // fields count
    u16be(0), // methods count
    u16be(0), // method attribute count
    u16be(0), // class attribute count
  ]);
}

/** Stored (uncompressed) multi-entry zip with real payloads. */
function craftZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const lfh = Buffer.concat([
      u32(LFH_SIG), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes,
    ]);
    const cdh = Buffer.concat([
      u32(CDH_SIG), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]);
    locals.push(lfh, data);
    centrals.push(cdh);
    offset += lfh.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(EOCD_SIG), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-findclass-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Open a context over a manifest written BEFORE construction (fresh, so
 * ensureReady serves it without running a resolver).
 */
async function contextWith(artifacts: DependencyArtifact[]): Promise<QueryContext> {
  const projectRoot = freshRoot();
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  await writeManifest(projectRoot, {
    version: 2,
    resolvedAt: "",
    dependencySetHash: await computeDependencySetHash(projectRoot),
    artifacts,
  });
  return openContext(projectRoot, { onNotice: () => {} });
}

/** The injected JVM answers: never spawns in these tests. */
const jvm = (available: boolean) => async () => ({ available });

const DEMO_SOURCES: DependencyArtifact = {
  coordinates: "com.example:demo-lib:1.0.0",
  kind: "external",
  sourcesJar: DEMO_SOURCES_JAR,
};
const DEMO_BINARY: DependencyArtifact = {
  coordinates: "com.example:demo-lib-bin:1.0.0",
  kind: "external",
  binaryJar: DEMO_JAR,
};

describe("findClass tiers over listings", () => {
  it("exact fqn, simple name, and segment-aligned suffix queries all hit with coordinates and version", async () => {
    const ctx = await contextWith([DEMO_SOURCES, DEMO_BINARY]);

    const exact = await findClass(ctx, "com.example.Demo");
    expect(exact.hits[0]).toMatchObject({
      fqn: "com.example.Demo",
      coordinates: "com.example:demo-lib:1.0.0",
      version: "1.0.0",
    });

    const simple = await findClass(ctx, "Demo");
    expect(simple.hits.map((h) => h.fqn)).toContain("com.example.Demo");

    const suffix = await findClass(ctx, "example.Demo");
    expect(suffix.hits.map((h) => h.fqn)).toContain("com.example.Demo");
  });

  it("a fuzzy query surfaces the demo class (tier 4)", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await findClass(ctx, "Dmo");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.Demo");
  });

  it("`Outer$1`-style entries never hit for any tier", async () => {
    const ctx = await contextWith([DEMO_BINARY]);
    for (const query of ["Outer$1", "Outer.1", "1"]) {
      const result = await findClass(ctx, query);
      expect(result.hits, query).toEqual([]);
    }
    // and the named classes of the same jar still surface
    const outer = await findClass(ctx, "com.example.Outer");
    expect(outer.hits.map((h) => h.fqn)).toContain("com.example.Outer");
    // the listing fqn keeps `$`; the displayed hit fqn is dotted (v1 parity)
    const inner = await findClass(ctx, "com.example.Outer.Inner");
    expect(inner.hits.map((h) => h.fqn)).toContain("com.example.Outer.Inner");
  });

  it("a bare-name query finds a nested class by its inner simple name (v1 tier parity)", async () => {
    // v1's store fqns were dotted, so `Worker` matched com.example.Demo.Worker
    // in the SIMPLE tier; listing fqns keep `$`, and the simple name of
    // `Demo$Worker` must still be `Worker` — not a fuzzy-tier afterthought
    const ctx = await contextWith([DEMO_BINARY]);
    const result = await findClass(ctx, "Worker");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.Demo.Worker");
    // and a name query does NOT sweep the nested class in under fuzzy
    const demo = await findClass(ctx, "Demo");
    expect(demo.hits.map((h) => h.fqn)).not.toContain("com.example.Demo.Worker");
  });

  it("dotted suffix queries hit a nested class — and `$`-spelled suffixes still work", async () => {
    // `Outer.Inner` and `example.Outer.Inner` are proper dotted suffixes of
    // the listing fqn `com.example.Outer$Inner` (v1 answered both); the raw
    // check stays so `$`-spelled suffix queries (`example.Outer$Inner`) hit
    // too. A DOTLESS `Outer$Inner` query is not a suffix query at all — the
    // suffix tier requires a `.` in the query, exactly as in v1
    const ctx = await contextWith([DEMO_BINARY]);
    for (const query of ["Outer.Inner", "example.Outer.Inner", "example.Outer$Inner"]) {
      const result = await findClass(ctx, query);
      expect(result.hits.map((h) => h.fqn), query).toContain("com.example.Outer.Inner");
    }
    const dotless = await findClass(ctx, "Outer$Inner");
    expect(dotless.hits).toEqual([]);
  });

  it("two artifacts declaring the same class each hit, in manifest order", async () => {
    const ctx = await contextWith([DEMO_SOURCES, DEMO_BINARY]);
    const result = await findClass(ctx, "com.example.Demo");
    expect(result.hits.map((h) => h.coordinates)).toEqual([
      "com.example:demo-lib:1.0.0",
      "com.example:demo-lib-bin:1.0.0",
    ]);
  });

  it("unreadable listings aggregate into one degraded string while good artifacts answer", async () => {
    const broken = join(freshRoot(), "broken.jar");
    writeFileSync(broken, "not a zip, just text padding to a plausible size");
    const ctx = await contextWith([
      { coordinates: "test:broken:1", kind: "external", binaryJar: broken },
      DEMO_SOURCES,
    ]);
    const result = await findClass(ctx, "com.example.Demo");
    expect(result.hits.map((h) => h.coordinates)).toContain("com.example:demo-lib:1.0.0");
    expect(result.degraded).toContain("1 artifacts unreadable (test:broken:1)");
  });
});

describe("findClass kind refinement", () => {
  it("a binary interface entry reports kind interface (one class-file parse)", async () => {
    const dir = freshRoot();
    const jar = join(dir, "iface.jar");
    writeFileSync(
      jar,
      craftZip([
        { name: "a/b/Widget.class", data: craftClassFile("a/b/Widget", 0x0201) }, // public interface
      ]),
    );
    const ctx = await contextWith([{ coordinates: "test:iface:1", kind: "external", binaryJar: jar }]);
    const result = await findClass(ctx, "a.b.Widget", { jvm: jvm(false) });
    expect(result.hits[0]).toMatchObject({ fqn: "a.b.Widget", kind: "interface" });
  });

  it("a sources-jar hit reports the parsed kind (Colors is an enum, Point a record)", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const colors = await findClass(ctx, "com.example.Colors");
    expect(colors.hits[0]!.kind).toBe("enum");
    const point = await findClass(ctx, "com.example.Point");
    expect(point.hits[0]!.kind).toBe("record");
  });

  it("kind falls back to class when the entry parses to no matching record", async () => {
    // a `.class` entry whose bytes are not a class file: the listing carries
    // the entry, refinement parses nothing, kind stays the default
    const dir = freshRoot();
    const jar = join(dir, "junk.jar");
    writeFileSync(
      jar,
      craftZip([{ name: "a/b/Junk.class", data: Buffer.from("definitely not a class file") }]),
    );
    const ctx = await contextWith([{ coordinates: "test:junk:1", kind: "external", binaryJar: jar }]);
    const result = await findClass(ctx, "a.b.Junk", { jvm: jvm(false) });
    expect(result.hits[0]).toMatchObject({ fqn: "a.b.Junk", kind: "class" });
  });

  it("beyond the refinement cap, kind stays class (no unbounded parse storm)", async () => {
    // 30 fuzzy hits with limit 30: refinement reads at most a small constant,
    // so the tail keeps the unrefined default kind
    const dir = freshRoot();
    const jar = join(dir, "many.jar");
    writeFileSync(
      jar,
      craftZip(
        Array.from({ length: 30 }, (_, i) => ({
          name: `a/b/Clz${i}.class`,
          data: craftClassFile(`a/b/Clz${i}`, 0x0201), // every one an interface
        })),
      ),
    );
    const ctx = await contextWith([{ coordinates: "test:many:1", kind: "external", binaryJar: jar }]);
    const result = await findClass(ctx, "Clz", { limit: 30, jvm: jvm(false) });
    expect(result.hits).toHaveLength(30); // fuzzy tier sliced to the raised limit
    const interfaces = result.hits.filter((h) => h.kind === "interface").length;
    const classes = result.hits.filter((h) => h.kind === "class").length;
    expect(interfaces).toBe(24); // the documented cap
    expect(classes).toBe(6);
  });
});

describe("findClass provenance promise", () => {
  it("a sources artifact promises source", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await findClass(ctx, "com.example.Demo", { jvm: jvm(false) });
    expect(result.hits[0]).toMatchObject({ provenance: "source" });
  });

  it("a sourceDir artifact promises source", async () => {
    const dir = freshRoot();
    mkdirSync(join(dir, "com", "mod"), { recursive: true });
    writeFileSync(
      join(dir, "com", "mod", "Svc.java"),
      "package com.mod;\npublic class Svc {}\n",
    );
    const ctx = await contextWith([{ coordinates: ":app", kind: "module", sourceDir: dir }]);
    const result = await findClass(ctx, "com.mod.Svc", { jvm: jvm(false) });
    expect(result.hits[0]).toMatchObject({ fqn: "com.mod.Svc", provenance: "source" });
  });

  it("a binary artifact with the JVM available promises decompiled", async () => {
    const ctx = await contextWith([
      { coordinates: "com.example:nosources-lib:1.0.0", kind: "external", binaryJar: NOSOURCES_JAR },
    ]);
    const result = await findClass(ctx, "com.example.nosources.Hidden", { jvm: jvm(true) });
    expect(result.hits[0]).toMatchObject({
      fqn: "com.example.nosources.Hidden",
      provenance: "decompiled",
    });
  });

  it("a binary artifact without a JVM promises signature", async () => {
    const ctx = await contextWith([
      { coordinates: "com.example:nosources-lib:1.0.0", kind: "external", binaryJar: NOSOURCES_JAR },
    ]);
    const result = await findClass(ctx, "com.example.nosources.Hidden", { jvm: jvm(false) });
    expect(result.hits[0]).toMatchObject({ provenance: "signature" });
  });
});

describe("findClass round-trip property (spec)", () => {
  it("every hit of every fixture-flow query maps onto a real entry of its artifact's jar", async () => {
    const ctx = await contextWith([DEMO_SOURCES, DEMO_BINARY]);
    const queries = [
      "com.example.Demo",
      "Demo",
      "example.Demo",
      "Dmo",
      "Outer",
      "Point",
      "e",
    ];
    const entriesByJar = new Map<string, Set<string>>();
    const entriesOf = async (jar: string): Promise<Set<string>> => {
      let set = entriesByJar.get(jar);
      if (set === undefined) {
        set = new Set((await listZipEntries(jar)).map((e) => e.name));
        entriesByJar.set(jar, set);
      }
      return set;
    };
    for (const query of queries) {
      const { hits } = await findClass(ctx, query, { jvm: jvm(false) });
      expect(hits.length, query).toBeGreaterThan(0);
      for (const hit of hits) {
        // the displayed fqn is dotted; entries spell nesting with `$`, so a
        // nested hit maps onto `Outer$Inner`: a trailing run of segments is
        // the class chain (`$`-joined, prefixed by the `/`-joined package).
        // Every split point is tried because the fqn alone does not say where
        // the package ends — the jar's entry set is the oracle.
        const parts = hit.fqn.split(".");
        const stems = [];
        for (let split = 1; split <= parts.length; split++) {
          const pkg = parts.slice(0, parts.length - split).join("/");
          const chain = parts.slice(parts.length - split).join("$");
          stems.push(pkg === "" ? chain : `${pkg}/${chain}`);
        }
        const source = hit.coordinates === "com.example:demo-lib:1.0.0" ? DEMO_SOURCES_JAR : DEMO_JAR;
        const names = await entriesOf(source);
        const has = [`.class`, `.java`].some((ext) =>
          stems.some((stem) => names.has(`${stem}${ext}`)),
        );
        expect(has, `${query} → ${hit.fqn} in ${hit.coordinates}`).toBe(true);
      }
    }
  });
});
