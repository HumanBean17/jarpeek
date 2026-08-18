import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isIndexableEntryName, ListingService } from "../../src/core/listing.js";
import type { DependencyArtifact } from "../../src/core/types.js";
import { listZipEntries } from "../../src/parse/zip.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");
const SOURCES_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0-sources.jar");

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

/**
 * Assemble a stored multi-entry zip by hand — the `scripts/build-fixtures.mjs`
 * shape minus the JDK dependency. Listing reads only the central directory,
 * so every payload is a 1-byte dummy and crc32 stays 0.
 */
function craftZip(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const size = 1;
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
    locals.push(lfh, Buffer.from("x"));
    centrals.push(cdh);
    offset += lfh.length + size;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0), // this disk
    u16(0), // disk with central directory
    u16(names.length), // entries on this disk
    u16(names.length), // total entries
    u32(cd.length),
    u32(offset),
    u16(0), // comment length
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Fresh temp dir the test removes in its finally block. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-listing-"));
}

/** Minimal artifact literal; listing() reads only the coordinates and backing paths. */
function artifact(
  fields: Pick<DependencyArtifact, "coordinates"> & Partial<DependencyArtifact>,
): DependencyArtifact {
  return { kind: "external", ...fields };
}

const fqns = (listing: { classes: { fqn: string }[] }): string[] => listing.classes.map((c) => c.fqn);

describe("ListingService.listing", () => {
  it("lists a binary jar's classes from its central directory", async () => {
    const service = new ListingService();
    const listing = await service.listing(
      artifact({ coordinates: "com.example:demo-lib:1.0.0", binaryJar: DEMO_JAR }),
    );
    expect(listing.source).toBe("binary");
    expect(listing.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(listing.unreadable).toBeUndefined();
    expect(fqns(listing)).toContain("com.example.Demo");
    expect(fqns(listing)).toContain("com.example.Demo$Worker");
    // the fixture's own anonymous class is dropped by the identifier filter
    expect(fqns(listing)).not.toContain("com.example.Outer$1");
    const demo = listing.classes.find((c) => c.fqn === "com.example.Demo")!;
    expect(demo.entry).toBe("com/example/Demo.class");
    // entries is the raw central-directory listing, classes and resources alike
    expect(listing.entries.some((e) => e.name === "META-INF/MANIFEST.MF")).toBe(true);
    expect(listing.stamp).toMatch(/^\d+(\.\d+)?:\d+$/);
  });

  it("drops module-info.class from a binary listing (crafted zip)", async () => {
    const dir = tempDir();
    try {
      const jar = join(dir, "mod.jar");
      writeFileSync(jar, craftZip(["module-info.class", "a/b/Api.class"]));
      const listing = await new ListingService().listing(
        artifact({ coordinates: "test:mod:1", binaryJar: jar }),
      );
      expect(fqns(listing)).toEqual(["a.b.Api"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives sources classes from .java entries with the extension stripped", async () => {
    const listing = await new ListingService().listing(
      artifact({ coordinates: "com.example:demo-lib:1.0.0", sourcesJar: SOURCES_JAR }),
    );
    expect(listing.source).toBe("sources");
    expect(fqns(listing).sort()).toEqual([
      "com.example.BigService",
      "com.example.Colors",
      "com.example.Demo",
      "com.example.Outer",
      "com.example.Point",
      "com.example.Res",
    ]);
    const demo = listing.classes.find((c) => c.fqn === "com.example.Demo")!;
    expect(demo.entry).toBe("com/example/Demo.java");
    expect(listing.entries.length).toBeGreaterThan(0);
  });

  it("walks a sourceDir with build outputs pruned and no zip entries", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "com/example"), { recursive: true });
      mkdirSync(join(dir, "build/gen"), { recursive: true });
      writeFileSync(join(dir, "com/example/Demo.java"), "package com.example;\npublic class Demo {}\n");
      writeFileSync(join(dir, "build/gen/Generated.java"), "package gen;\npublic class Generated {}\n");
      const listing = await new ListingService().listing(
        artifact({ coordinates: "test:module:1", sourceDir: dir }),
      );
      expect(listing.source).toBe("sourceDir");
      expect(fqns(listing)).toEqual(["com.example.Demo"]);
      expect(listing.entries).toEqual([]);
      expect(listing.stamp).toMatch(/^\d+(\.\d+)?:\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers binaryJar over sourcesJar over sourceDir", async () => {
    const listing = await new ListingService().listing(
      artifact({
        coordinates: "test:prefer:1",
        binaryJar: DEMO_JAR,
        sourcesJar: SOURCES_JAR,
        sourceDir: join(FIXTURES, "src", "java"),
      }),
    );
    expect(listing.source).toBe("binary");
    expect(fqns(listing)).toContain("com.example.Demo");
  });

  it("drops digit nested-class entry names but keeps named ones", async () => {
    expect(isIndexableEntryName("a/b/Outer$1.class")).toBe(false);
    expect(isIndexableEntryName("a/b/Outer$Inner.class")).toBe(true);
    expect(isIndexableEntryName("com/example/Demo.java")).toBe(true);
    const dir = tempDir();
    try {
      const jar = join(dir, "nested.jar");
      writeFileSync(jar, craftZip(["a/b/Outer.class", "a/b/Outer$1.class", "a/b/Outer$Inner.class"]));
      const listing = await new ListingService().listing(
        artifact({ coordinates: "test:nested:1", binaryJar: jar }),
      );
      expect(fqns(listing)).toEqual(["a.b.Outer", "a.b.Outer$Inner"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches by coordinates and re-lists when the jar's stamp changes", async () => {
    const dir = tempDir();
    try {
      const jar = join(dir, "demo.jar");
      copyFileSync(DEMO_JAR, jar);
      let calls = 0;
      const service = new ListingService({
        listZip: async (path) => {
          calls++;
          return listZipEntries(path);
        },
      });
      const artifactSpec = artifact({ coordinates: "test:cache:1", binaryJar: jar });
      const first = await service.listing(artifactSpec);
      expect(calls).toBe(1);
      const second = await service.listing(artifactSpec);
      expect(calls).toBe(1);
      expect(second).toBe(first); // same cached listing object
      const later = new Date(Date.now() + 10_000);
      utimesSync(jar, later, later);
      const third = await service.listing(artifactSpec);
      expect(calls).toBe(2);
      expect(third.stamp).not.toBe(first.stamp);
      service.invalidate("test:cache:1");
      await service.listing(artifactSpec);
      expect(calls).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks an unlistable jar unreadable and re-lists once the stamp changes", async () => {
    const dir = tempDir();
    try {
      const jar = join(dir, "broken.jar");
      writeFileSync(jar, "not a zip, just text padding to a plausible size");
      const service = new ListingService();
      const artifactSpec = artifact({ coordinates: "test:broken:1", binaryJar: jar });
      const bad = await service.listing(artifactSpec);
      expect(bad.unreadable).toBeDefined();
      expect(bad.classes).toEqual([]);
      expect(bad.entries).toEqual([]);
      copyFileSync(DEMO_JAR, jar); // different size → different stamp → cached failure retried
      const good = await service.listing(artifactSpec);
      expect(good.unreadable).toBeUndefined();
      expect(fqns(good)).toContain("com.example.Demo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an artifact with no backing at all as unreadable", async () => {
    const listing = await new ListingService().listing(artifact({ coordinates: "test:nowhere:1" }));
    expect(listing).toMatchObject({
      source: "binary",
      classes: [],
      entries: [],
      stamp: "",
      unreadable: "no jar or source dir",
    });
  });
});

describe("ListingService.listing explicit backing", () => {
  it("backing: 'sources' lists the sources jar of a both-backings artifact", async () => {
    const service = new ListingService();
    const spec = artifact({
      coordinates: "com.example:demo-lib:1.0.0",
      binaryJar: DEMO_JAR,
      sourcesJar: SOURCES_JAR,
    });
    const listing = await service.listing(spec, { backing: "sources" });
    expect(listing.source).toBe("sources");
    expect(fqns(listing)).toContain("com.example.Demo");
    expect(listing.classes.find((c) => c.fqn === "com.example.Demo")!.entry).toBe(
      "com/example/Demo.java",
    );
  });

  it("backing: 'binary' lists the binary jar even when sourceDir outranks nothing", async () => {
    const listing = await new ListingService().listing(
      artifact({ coordinates: "com.example:demo-lib:1.0.0", binaryJar: DEMO_JAR }),
      { backing: "binary" },
    );
    expect(listing.source).toBe("binary");
    expect(fqns(listing)).toContain("com.example.Demo$Worker");
  });

  it("an explicit backing that does not exist is unreadable, and a requested sourceDir lists its walk", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "com/example"), { recursive: true });
      writeFileSync(join(dir, "com/example/Demo.java"), "package com.example;\npublic class Demo {}\n");
      const service = new ListingService();
      const spec = artifact({
        coordinates: "test:backings:1",
        binaryJar: DEMO_JAR,
        sourceDir: dir,
      });
      const fromDir = await service.listing(spec, { backing: "sourceDir" });
      expect(fromDir.source).toBe("sourceDir");
      expect(fqns(fromDir)).toEqual(["com.example.Demo"]);

      const missing = await service.listing(
        artifact({ coordinates: "test:backings:2", binaryJar: DEMO_JAR }),
        { backing: "sources" },
      );
      expect(missing.unreadable).toBe("no jar or source dir");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the default path's cache identity is untouched: default and explicit backings cache apart", async () => {
    const dir = tempDir();
    try {
      const jar = join(dir, "demo.jar");
      copyFileSync(DEMO_JAR, jar);
      let calls = 0;
      const service = new ListingService({
        listZip: async (path) => {
          calls++;
          return listZipEntries(path);
        },
      });
      const spec = artifact({ coordinates: "test:split:1", binaryJar: jar, sourcesJar: SOURCES_JAR });
      const def1 = await service.listing(spec);
      expect(calls).toBe(1);
      // repeat default: cached, no new list
      await service.listing(spec);
      expect(calls).toBe(1);
      // explicit sources: a separate cache lane, listed once
      const src1 = await service.listing(spec, { backing: "sources" });
      expect(src1.source).toBe("sources");
      expect(calls).toBe(2);
      await service.listing(spec, { backing: "sources" });
      expect(calls).toBe(2);
      // and the default lane is still warm
      await service.listing(spec);
      expect(calls).toBe(2);
      expect(def1.source).toBe("binary");
      service.invalidate("test:split:1");
      await service.listing(spec);
      expect(calls).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
