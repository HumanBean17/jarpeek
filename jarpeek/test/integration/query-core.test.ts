import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { findClass } from "../../src/core/query/find-class.js";
import { outline, LookupMissError } from "../../src/core/query/outline.js";
import { readSource } from "../../src/core/query/read-source.js";
import { searchSymbols } from "../../src/core/query/search-symbols.js";
import { readManifest } from "../../src/index/manifest.js";
import { splitLines } from "../../src/util/lines.js";
import { readTextEntry, listZipEntries } from "../../src/parse/zip.js";
import type { Declaration, DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const JARS = join(FIXTURES, "jars");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

/** A minimal class record for shards written directly to the store in tests. */
function classRecord(fqn: string, signature: string): Declaration {
  return {
    fqn,
    file: `${fqn.replaceAll(".", "/")}.java`,
    selector: fqn.slice(fqn.lastIndexOf(".") + 1),
    kind: "class",
    visibility: "public",
    static: false,
    deprecated: false,
    signature,
  };
}

interface Ctx {
  projectRoot: string;
  cacheDir: string;
  dupDir: string;
  ctx: QueryContext;
  resolverCallCount: () => number;
  makeResolverThrow: () => void;
}

const c = {} as Ctx;

beforeAll(async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-query-project-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "jarpeek-query-cache-"));
  // gradle marker so the resolver facade routes to the injected fake
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");

  // a second manifest artifact declaring the same fqn as demo-lib: colliding
  // artifacts that the manifest KNOWS still produce winner + alternatives
  const dupDir = mkdtempSync(join(tmpdir(), "jarpeek-query-dup-"));
  mkdirSync(join(dupDir, "com", "example"), { recursive: true });
  writeFileSync(
    join(dupDir, "com", "example", "Demo.java"),
    "package com.example;\n\npublic class Demo {}\n",
  );

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
      coordinates: "com.other:dup:1",
      kind: "external",
      sourceDir: dupDir,
      provenance: "source",
      warnings: [],
    },
  ];

  let resolverCallCount = 0;
  let gradleImpl: () => Promise<{ ok: boolean; artifacts: DependencyArtifact[] }> = async () => ({
    ok: true,
    artifacts,
  });
  const fakeGradle = async () => {
    resolverCallCount++;
    return gradleImpl();
  };
  const makeResolverThrow = () => {
    gradleImpl = async () => {
      throw new Error("resolver exploded");
    };
  };

  const ctx = openContext(projectRoot, {
    resolvers: { gradle: fakeGradle, includeJdk: false },
    cacheDir,
    onProgress: () => {},
  });

  Object.assign(c, {
    projectRoot,
    cacheDir,
    dupDir,
    ctx,
    resolverCallCount: () => resolverCallCount,
    makeResolverThrow,
  });
});

afterAll(() => {
  rmSync(c.projectRoot, { recursive: true, force: true });
  rmSync(c.cacheDir, { recursive: true, force: true });
  rmSync(c.dupDir, { recursive: true, force: true });
});

async function demoSource(): Promise<string> {
  const entries = await listZipEntries(DEMO_SOURCES_JAR);
  const entry = entries.find((e) => e.name === "com/example/Demo.java");
  expect(entry, "demo sources jar should carry Demo.java").toBeDefined();
  return readTextEntry(DEMO_SOURCES_JAR, entry!);
}

describe("query context bootstrap", () => {
  it("first findClass resolves+indexes exactly once; second call reuses the fresh manifest", async () => {
    expect(c.resolverCallCount()).toBe(0);
    await findClass(c.ctx, "Demo");
    expect(c.resolverCallCount()).toBe(1);
    await findClass(c.ctx, "Demo");
    expect(c.resolverCallCount()).toBe(1);

    const manifest = await readManifest(c.projectRoot);
    expect(manifest).not.toBeNull();
    expect(manifest!.artifacts.map((a) => a.coordinates)).toEqual([
      "com.example:demo-lib:1.0.0",
      "com.example:nosources-lib:1.0.0",
      "com.other:dup:1",
    ]);
  });
});

describe("findClass", () => {
  it("exact FQN hit with coordinates, version, provenance and kind", async () => {
    const result = await findClass(c.ctx, "com.example.Demo");
    expect(result.hits[0]).toMatchObject({
      fqn: "com.example.Demo",
      coordinates: "com.example:demo-lib:1.0.0",
      version: "1.0.0",
      provenance: "source",
      kind: "class",
    });
    expect(Array.isArray(result.degraded)).toBe(true);
  });

  it("suffix match on full dot-segments", async () => {
    const result = await findClass(c.ctx, "example.Demo");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.Demo");
  });

  it("simple-name match", async () => {
    const result = await findClass(c.ctx, "Demo");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.Demo");
  });

  it("fuzzy match finds Demo; fuzzy miss yields no hits", async () => {
    const fuzzy = await findClass(c.ctx, "Dmo");
    expect(fuzzy.hits.map((h) => h.fqn)).toContain("com.example.Demo");

    const miss = await findClass(c.ctx, "Zzzzz");
    expect(miss.hits).toEqual([]);
  });
});

describe("outline", () => {
  it("winner rows carry members and nested classes", async () => {
    const result = await outline(c.ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    expect(result.stale).toBeUndefined();

    const selectors = result.rows.map((r) => r.selector);
    expect(selectors).toContain("run");
    expect(selectors).toContain("NAME");
    expect(result.rows.some((r) => r.selector === "run" && r.kind === "method")).toBe(true);
    expect(result.rows.some((r) => r.selector === "NAME" && r.kind === "field")).toBe(true);
    expect(result.rows.some((r) => r.selector === "Worker" && r.kind === "class")).toBe(true);
  });

  it("kind filter excludes other kinds", async () => {
    const result = await outline(c.ctx, "com.example.Demo", { kind: "method" });
    expect(result.rows.some((r) => r.selector === "NAME")).toBe(false);
    expect(result.rows.every((r) => r.kind === "method")).toBe(true);
  });

  it("visibility filter keeps only private members", async () => {
    const result = await outline(c.ctx, "com.example.Demo", { visibility: "private" });
    expect(result.rows.map((r) => r.selector)).toEqual(["NAME"]);
  });
});

describe("readSource", () => {
  it("defaults to outline mode", async () => {
    const result = await readSource(c.ctx, "com.example.Demo");
    expect(result.mode).toBe("outline");
    expect(result.rows.map((r) => r.selector)).toContain("run");
  });

  it("full mode from sources: exact fixture content, provenance source", async () => {
    const fixture = await demoSource();
    const result = await readSource(c.ctx, "com.example.Demo", { mode: "full" });
    expect(result.mode).toBe("full");
    expect(result.provenance).toBe("source");
    expect(result.content).toBe(fixture);
    expect(result.file).toBe("com/example/Demo.java");
    expect(result.startLine).toBe(1);
    expect(result.lineCount).toBe(splitLines(fixture).length);
    expect(result.lineCount).toBeGreaterThan(50);
  });

  it("full mode on a big source file reports lineCount over 100", async () => {
    const result = await readSource(c.ctx, "com.example.BigService", { mode: "full" });
    expect(result.lineCount).toBeGreaterThan(100);
  });

  it("lines mode slices and reports clamping", async () => {
    const fixture = await demoSource();
    const all = splitLines(fixture);

    const sliced = await readSource(c.ctx, "com.example.Demo", { mode: "lines", from: 2, to: 4 });
    expect(sliced.mode).toBe("lines");
    expect(sliced.lines).toEqual(all.slice(1, 4));
    expect(sliced.startLine).toBe(2);
    expect(sliced.endLine).toBe(4);
    expect(sliced.clamped).toBe(false);

    const clamped = await readSource(c.ctx, "com.example.Demo", { mode: "lines", from: 999, to: 1000 });
    expect(clamped.mode).toBe("lines");
    expect(clamped.clamped).toBe(true);
    expect(clamped.lines).toEqual([]);
  });

  it("lines mode requires from and to", async () => {
    await expect(readSource(c.ctx, "com.example.Demo", { mode: "lines" })).rejects.toThrow(
      "lines mode requires from and to",
    );
  });

  it("full mode on a binary-only artifact decompiles", async () => {
    const result = await readSource(c.ctx, "com.example.nosources.Hidden", { mode: "full" });
    expect(result.mode).toBe("full");
    expect(result.provenance).toBe("decompiled");
    expect(result.file).toBe("com/example/nosources/Hidden.java (decompiled)");
    expect(result.content).toContain("class Hidden");
  });

  it("full mode on a noDecompile jdk artifact renders signatures only", async () => {
    await c.ctx.store.writeArtifact(
      {
        coordinates: "jdk:fake",
        kind: "jdk",
        provenance: "signature",
        noDecompile: true,
        warnings: [],
      },
      [
        {
          fqn: "jdk.fake.Fake",
          file: "java.base/jdk/fake/Fake.class",
          selector: "Fake",
          kind: "class",
          visibility: "public",
          static: false,
          deprecated: false,
          signature: "public class Fake",
        },
        {
          fqn: "jdk.fake.Fake",
          file: "java.base/jdk/fake/Fake.class",
          selector: "size",
          kind: "method",
          visibility: "public",
          static: false,
          deprecated: false,
          signature: "public int size()",
        },
      ],
    );

    const result = await readSource(c.ctx, "jdk.fake.Fake", { mode: "full" });
    expect(result.mode).toBe("full");
    expect(result.provenance).toBe("signature");
    expect(result.content.split("\n")[0]).toBe("signatures only (jdk: decompilation is out of scope)");
    expect(result.content).toContain("public class Fake");
    expect(result.content).toContain("public int size()");
  });
});

describe("collisions and misses", () => {
  it("manifest position wins; later shards surface as alternatives", async () => {
    // demo-lib and the dup artifact are both IN the manifest and both declare
    // com.example.Demo: the earlier manifest position is the winner, the other
    // shard surfaces as an alternative
    const result = await outline(c.ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.alternatives).toContainEqual({ coordinates: "com.other:dup:1" });
  });

  it("lookup miss throws LookupMissError carrying the fqn", async () => {
    const err = await outline(c.ctx, "com.example.Missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookupMissError);
    expect((err as Error).name).toBe("LookupMissError");
    expect((err as LookupMissError).fqn).toBe("com.example.Missing");
  });
});

describe("manifest scoping (the cache store is user-global)", () => {
  it("an fqn only in out-of-manifest shards is served by outline with a degraded warning, and excluded from findClass", async () => {
    await c.ctx.store.writeArtifact(
      {
        coordinates: "com.gone:old-lib:1",
        kind: "external",
        provenance: "signature",
        warnings: [],
      },
      [classRecord("com.gone.Old", "public class Old")],
    );

    // find_class never lies: out-of-manifest shards are not search results
    const found = await findClass(c.ctx, "com.gone.Old");
    expect(found.hits).toEqual([]);

    // a direct lookup still answers — honestly flagged as out of the set
    const result = await outline(c.ctx, "com.gone.Old");
    expect(result.coordinates).toBe("com.gone:old-lib:1");
    expect(result.rows.map((r) => r.selector)).toContain("Old");
    expect(result.degraded).toContain("artifact no longer in dependency set");
  });

  it("an out-of-manifest shard colliding with a manifest hit is excluded from hits and alternatives", async () => {
    await c.ctx.store.writeArtifact(
      {
        coordinates: "com.other:gone-dup:2",
        kind: "external",
        provenance: "signature",
        warnings: [],
      },
      [classRecord("com.example.Demo", "public class Demo")],
    );

    const found = await findClass(c.ctx, "Demo");
    expect(found.hits.map((h) => h.coordinates)).not.toContain("com.other:gone-dup:2");
    expect(found.hits.map((h) => h.coordinates)).toContain("com.example:demo-lib:1.0.0");

    const result = await outline(c.ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.alternatives ?? []).not.toContainEqual({ coordinates: "com.other:gone-dup:2" });
  });

  it("search_symbols skips records from out-of-manifest shards", async () => {
    await c.ctx.store.writeArtifact(
      {
        coordinates: "com.gone:old-lib:1",
        kind: "external",
        provenance: "signature",
        warnings: [],
      },
      [
        classRecord("com.gone.Old", "public class Old"),
        {
          ...classRecord("com.gone.Old", "public class Old"),
          selector: "goneOnlyMember",
          kind: "method",
          signature: "public void goneOnlyMember()",
        },
      ],
    );

    const rows = await searchSymbols(c.ctx, "goneOnlyMember");
    expect(rows.rows).toEqual([]);
  });

  it("bounded fuzzy collection keeps ranking identical to a full sort", async () => {
    const wide = await searchSymbols(c.ctx, "e", { limit: 1000 });
    expect(wide.rows.length).toBeGreaterThan(5);
    const narrow = await searchSymbols(c.ctx, "e", { limit: 5 });
    expect(narrow.rows).toEqual(wide.rows.slice(0, 5));
  });
});

describe("stale index served", () => {
  it("resolver failure after a build-file change serves the old index with stale: true", async () => {
    const buildGradle = join(c.projectRoot, "build.gradle");
    const future = new Date(Date.now() + 60_000);
    utimesSync(buildGradle, future, future);

    c.makeResolverThrow();

    const result = await outline(c.ctx, "com.example.Demo");
    expect(result.stale).toBe(true);
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.rows.map((r) => r.selector)).toContain("run");
    expect(result.degraded.some((d) => d.includes("stale"))).toBe(true);
  });
});
