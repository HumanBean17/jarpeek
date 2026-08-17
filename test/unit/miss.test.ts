import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMiss } from "../../src/core/miss.js";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { LookupMissError } from "../../src/core/query/outline.js";
import { ListingService } from "../../src/core/listing.js";
import type { DependencyArtifact } from "../../src/core/types.js";
import { computeDependencySetHash, writeManifest, type Manifest } from "../../src/index/manifest.js";

const DEMO_SOURCES_JAR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "jars",
  "demo-lib-1.0.0-sources.jar",
);

/**
 * Stored single-entry zip whose one source entry declares `fqn` — the JDK
 * step's retry needs locateClass to actually FIND the class, so the stub
 * JDK artifact points at a jar carrying the queried entry.
 */
function sourcesJarFor(fqn: string): string {
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
  const entryName = `${fqn.replaceAll(".", "/")}.java`;
  const payload = Buffer.from(`package ${fqn.slice(0, fqn.lastIndexOf("."))};\npublic class ${fqn.slice(fqn.lastIndexOf(".") + 1)} {}\n`);
  const nameBytes = Buffer.from(entryName, "utf8");
  const lfh = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(payload.length), u32(payload.length), u16(nameBytes.length), u16(0), nameBytes,
  ]);
  const cdh = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
    u32(payload.length), u32(payload.length), u16(nameBytes.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(0), nameBytes,
  ]);
  const zip = Buffer.concat([
    lfh, payload, cdh,
    Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(cdh.length), u32(lfh.length + payload.length), u16(0),
    ]),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-miss-jdkjar-"));
  roots.push(dir);
  const jar = join(dir, "jdk-sources.jar");
  writeFileSync(jar, zip);
  return jar;
}

interface ShardHit {
  safe: string;
  meta: DependencyArtifact;
  records: unknown[];
}

/**
 * Duck-typed QueryContext: only the members handleMiss consumes — findClass
 * still reads store.forEachRecord (Task 8 swaps it to listings), retryLookup
 * reads listings.listing via locateClass. Tests wire store/listings/manifest
 * per scenario; the default listings service has nothing to list (every
 * retry misses), so scenarios that expect a hit hand it a real jar artifact.
 */
interface StubCtx {
  projectRoot: string;
  cacheDir: string;
  store: {
    lookup(fqn: string): Promise<ShardHit[]>;
    forEachRecord(fn: (rec: never, safe: string) => void | Promise<void>): Promise<string[]>;
  };
  listings: ListingService;
  manifest(): Promise<Manifest | null>;
  ensureReady(): Promise<{ bootstrapped: boolean; stale: boolean }>;
  bootstrapWarnings(): string[];
}

const asCtx = (stub: StubCtx): QueryContext => stub as unknown as QueryContext;

const roots: string[] = [];
function stubRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-miss-stub-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function manifestOf(artifacts: DependencyArtifact[], dependencySetHash = "stub-hash"): Manifest {
  return { version: 1, resolvedAt: new Date().toISOString(), dependencySetHash, artifacts };
}

function artifact(coordinates: string, kind: DependencyArtifact["kind"] = "external"): DependencyArtifact {
  return { coordinates, kind, provenance: "source", warnings: [] };
}

const noRecords = async (): Promise<string[]> => [];
const noListings = new ListingService();

describe("handleMiss step 1: fuzzy candidates", () => {
  it("a class-lookup miss with findClass hits returns them via fuzzy-candidates", async () => {
    const zzzHelper: Declaration = {
      fqn: "com.example.ZzzHelper",
      file: "com/example/ZzzHelper.java",
      selector: "ZzzHelper",
      kind: "class",
      visibility: "public",
      static: false,
      deprecated: false,
      signature: "public class ZzzHelper",
    };
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async () => [],
        forEachRecord: async (fn) => {
          await fn(zzzHelper, "com.example%3Aother%3A1");
          return [];
        },
      },
      listings: noListings,
      manifest: async () => manifestOf([artifact("com.example:other:1")]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: async () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("com.example.Zzz"));
    expect(result).toMatchObject({ found: true, via: "fuzzy-candidates" });
    if (!result.found) throw new Error("unreachable");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.ZzzHelper");
  });
});

describe("handleMiss step 2: JDK namespace routing", () => {
  it("java.* miss retries the lookup and reports via jdk when the JDK artifact is indexed", async () => {
    // locateClass answers the retry: the JDK artifact carries a sources jar
    // with the queried fqn's entry
    const jdk = {
      ...artifact("jdk:25", "jdk"),
      sourcesJar: sourcesJarFor("java.util.FakeMiss"),
    };
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async () => [],
        forEachRecord: noRecords,
      },
      listings: new ListingService(),
      manifest: async () => manifestOf([jdk]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: async () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("java.util.FakeMiss"));
    expect(result).toEqual({ found: true, via: "jdk", coordinates: "jdk:25", provenance: "source" });
  });

  it("javax/jdk/sun/org.w3c.dom/org.xml.sax/org.ietf.jgss prefixes all route", async () => {
    for (const fqn of [
      "javax.script.Fake",
      "jdk.nio.Fake",
      "sun.net.Fake",
      "org.w3c.dom.Fake",
      "org.xml.sax.Fake",
      "org.ietf.jgss.Fake",
    ]) {
      const stub: StubCtx = {
        projectRoot: stubRoot(),
        cacheDir: "/tmp/irrelevant",
        store: { lookup: async () => [], forEachRecord: noRecords },
        listings: noListings,
        manifest: async () => manifestOf([]),
        ensureReady: async () => ({ bootstrapped: false, stale: false }),
        bootstrapWarnings: async () => [],
      };
      const result = await handleMiss(asCtx(stub), new LookupMissError(fqn), {
        // injected so the unit test never touches a real JDK install
        resolvers: { jdk: async () => ({ artifact: null, warnings: [] }) },
      });
      expect(result.found, fqn).toBe(false);
    }
  });
});

describe("handleMiss step 3: staleness re-resolve", () => {
  it("stale manifest triggers ensureReady then a retry, reported via re-resolve", async () => {
    const late = { ...artifact("com.example:late:1"), sourcesJar: DEMO_SOURCES_JAR };
    let ensureReadyCalls = 0;
    // the manifest flips from the stale no-hit set to a hit-bearing set once
    // ensureReady "re-resolved": retryLookup's locateClass sees the new one
    let resolved = false;
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async () => [],
        forEachRecord: noRecords,
      },
      listings: new ListingService(),
      manifest: async () => manifestOf(resolved ? [late] : [artifact("com.example:gone:1")], "deliberately-stale-hash"),
      ensureReady: async () => {
        ensureReadyCalls++;
        resolved = true;
        return { bootstrapped: true, stale: false };
      },
      bootstrapWarnings: async () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("com.example.Demo"));
    expect(result).toEqual({
      found: true,
      via: "re-resolve",
      coordinates: "com.example:late:1",
      provenance: "source",
    });
    expect(ensureReadyCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("handleMiss step 4: negative", () => {
  it("exhausted protocol returns searched artifacts, cache-scan note, and the extension note", async () => {
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: { lookup: async () => [], forEachRecord: noRecords },
      listings: noListings,
      manifest: async () =>
        manifestOf([artifact("com.example:demo-lib:1.0.0"), artifact("com.example:nosources-lib:1.0.0")]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: async () => ["degraded-to-cache-scan"],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("com.example.Nowhere"));
    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.via).toBe("negative");
    expect(result.searchedArtifacts).toContain("com.example:demo-lib:1.0.0");
    expect(result.searchedArtifacts).toContain("com.example:nosources-lib:1.0.0");
    expect(result.searchedArtifacts.some((s) => s.includes("cache-scan"))).toBe(true);
    expect(result.note).toContain("planned extension");
  });

  it("a query-shaped miss (no fqn) skips the class steps and reports negative", async () => {
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: { lookup: async () => [], forEachRecord: noRecords },
      listings: noListings,
      manifest: async () => manifestOf([artifact("com.example:demo-lib:1.0.0")]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: async () => [],
    };
    const result = await handleMiss(asCtx(stub), { query: "some-resource-glob" });
    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.via).toBe("negative");
    expect(result.searchedArtifacts).toEqual(["com.example:demo-lib:1.0.0"]);
  });
});

describe("handleMiss staleness snapshot (fix round 1)", () => {
  it("stale manifest + JDK absent + failed jdk retry still reaches the re-resolve step", async () => {
    let ensureReadyCalls = 0;
    let jdkResolves = 0;
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: { lookup: async () => [], forEachRecord: noRecords },
      listings: noListings,
      manifest: async () => manifestOf([artifact("com.example:demo-lib:1.0.0")], "gone-stale"),
      ensureReady: async () => {
        ensureReadyCalls++;
        return { bootstrapped: true, stale: false };
      },
      bootstrapWarnings: async () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("java.util.Gone"), {
      resolvers: {
        jdk: async () => {
          jdkResolves++;
          return { artifact: null, warnings: [] };
        },
      },
    });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.via).toBe("negative");
    expect(jdkResolves).toBe(1);
    // one ensureReady from step 1's findClass, at least one from step 3's
    // re-resolve — the negative answer comes only after that retry
    expect(ensureReadyCalls).toBeGreaterThanOrEqual(2);
  });

  it("fresh manifest + JDK absent: step 2 success skips step 3 entirely", async () => {
    const projectRoot = stubRoot();
    let ensureReadyCalls = 0;
    const freshHash = await computeDependencySetHash(projectRoot);
    // the JDK artifact is already manifest-listed and carries a sources jar
    // with the queried entry, so step 2's retry locates the class and skips step 3
    const jdk = { ...artifact("jdk:25", "jdk"), sourcesJar: sourcesJarFor("java.util.Fresh") };
    const stub: StubCtx = {
      projectRoot,
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async () => [],
        forEachRecord: noRecords,
      },
      listings: new ListingService(),
      manifest: async () => manifestOf([jdk], freshHash),
      ensureReady: async () => {
        ensureReadyCalls++;
        return { bootstrapped: false, stale: false };
      },
      bootstrapWarnings: async () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("java.util.Fresh"), {
      resolvers: { jdk: async () => ({ artifact: null, warnings: [] }) },
    });
    expect(result).toMatchObject({ found: true, via: "jdk" });
    // only step 1's findClass ensureReady ran — step 3 was skipped
    expect(ensureReadyCalls).toBe(1);
  });

  it("step 2's JDK indexing cannot mask a pre-existing staleness (forced re-resolve still runs)", async () => {
    // real context + real manifest: a failed resolve left a stale manifest
    // without the JDK; step 2 then indexes the JDK over that stale artifact
    // set, which re-stamps the manifest fresh — step 3 must re-resolve anyway
    const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-miss-mask-p-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "jarpeek-miss-mask-c-"));
    roots.push(projectRoot, cacheDir);
    writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
    const classesDir = mkdtempSync(join(tmpdir(), "jarpeek-miss-mask-jdk-"));
    roots.push(classesDir);

    const demo: DependencyArtifact = {
      coordinates: "com.example:demo-lib:1.0.0",
      kind: "external",
      sourcesJar: DEMO_SOURCES_JAR,
      provenance: "source",
      warnings: [],
    };
    await writeManifest(projectRoot, {
      version: 1,
      resolvedAt: new Date(0).toISOString(),
      dependencySetHash: "deliberately-stale",
      artifacts: [demo],
    });

    let gradleCalls = 0;
    let jdkResolves = 0;
    const resolvers = {
      gradle: async () => {
        gradleCalls++;
        throw new Error("gradle exploded");
      },
      jdk: async () => {
        jdkResolves++;
        return {
          artifact: {
            coordinates: "jdk:fake",
            kind: "jdk" as const,
            provenance: "signature" as const,
            classesDir,
            noDecompile: true,
            warnings: [],
          },
          warnings: [],
        };
      },
      includeJdk: false as const,
    };
    const ctx = openContext(projectRoot, { resolvers, cacheDir, onProgress: () => {} });

    const result = await handleMiss(ctx, new LookupMissError("java.util.Absent"), { resolvers });

    expect(result.found).toBe(false);
    if (result.found) throw new Error("unreachable");
    expect(result.via).toBe("negative");
    expect(jdkResolves).toBe(1); // step 2 resolved the JDK over the stale set
    // call 1: step 1's ensureReady re-resolve attempt (gradle threw);
    // call 2: step 3's forced re-resolve — this is the regression assertion:
    // it must happen even though step 2 re-stamped the manifest fresh
    expect(gradleCalls).toBe(2);
    // step 4 reports the manifest as it now stands (demo + the JDK step 2 added)
    expect(result.searchedArtifacts).toContain("com.example:demo-lib:1.0.0");
    expect(result.searchedArtifacts).toContain("jdk:fake");
  });
});
