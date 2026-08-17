import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMiss } from "../../src/core/miss.js";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { LookupMissError } from "../../src/core/query/outline.js";
import type { Declaration, DependencyArtifact } from "../../src/core/types.js";
import { computeDependencySetHash, writeManifest, type Manifest } from "../../src/index/manifest.js";

const DEMO_SOURCES_JAR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "jars",
  "demo-lib-1.0.0-sources.jar",
);

interface ShardHit {
  safe: string;
  meta: DependencyArtifact;
  records: Declaration[];
}

/**
 * Duck-typed QueryContext: only the methods handleMiss (and the findClass /
 * orderedLookup it calls) consume. Tests wire lookup/forEachRecord/manifest
 * per scenario.
 */
interface StubCtx {
  projectRoot: string;
  cacheDir: string;
  store: {
    lookup(fqn: string): Promise<ShardHit[]>;
    forEachRecord(fn: (rec: Declaration, safe: string) => void | Promise<void>): Promise<void>;
  };
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

const noRecords = async (): Promise<void> => {};

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
        },
      },
      manifest: async () => manifestOf([artifact("com.example:other:1")]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("com.example.Zzz"));
    expect(result).toMatchObject({ found: true, via: "fuzzy-candidates" });
    if (!result.found) throw new Error("unreachable");
    expect(result.hits.map((h) => h.fqn)).toContain("com.example.ZzzHelper");
  });
});

describe("handleMiss step 2: JDK namespace routing", () => {
  it("java.* miss retries the lookup and reports via jdk when the JDK artifact is indexed", async () => {
    const fakeMiss: Declaration = {
      fqn: "java.util.FakeMiss",
      file: "java.base/java/util/FakeMiss.java",
      selector: "FakeMiss",
      kind: "class",
      visibility: "public",
      static: false,
      deprecated: false,
      signature: "public class FakeMiss",
    };
    const jdk = { ...artifact("jdk:25", "jdk"), sourcesJar: "/jdk/lib/src.zip" };
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async (fqn) =>
          fqn === "java.util.FakeMiss"
            ? [{ safe: "jdk%3A25", meta: jdk, records: [fakeMiss] }]
            : [],
        forEachRecord: noRecords,
      },
      manifest: async () => manifestOf([jdk]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: () => [],
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
        manifest: async () => manifestOf([]),
        ensureReady: async () => ({ bootstrapped: false, stale: false }),
        bootstrapWarnings: () => [],
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
    const late: Declaration = {
      fqn: "com.example.Late",
      file: "com/example/Late.java",
      selector: "Late",
      kind: "class",
      visibility: "public",
      static: false,
      deprecated: false,
      signature: "public class Late",
    };
    let ensureReadyCalls = 0;
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async (fqn) =>
          ensureReadyCalls > 0 && fqn === "com.example.Late"
            ? [{ safe: "com.example%3Alate%3A1", meta: artifact("com.example:late:1"), records: [late] }]
            : [],
        forEachRecord: noRecords,
      },
      manifest: async () => manifestOf([artifact("com.example:late:1")], "deliberately-stale-hash"),
      ensureReady: async () => {
        ensureReadyCalls++;
        return { bootstrapped: true, stale: false };
      },
      bootstrapWarnings: () => [],
    };

    const result = await handleMiss(asCtx(stub), new LookupMissError("com.example.Late"));
    expect(result).toEqual({
      found: true,
      via: "re-resolve",
      coordinates: "com.example:late:1",
      provenance: "source",
    });
  });
});

describe("handleMiss step 4: negative", () => {
  it("exhausted protocol returns searched artifacts, cache-scan note, and the extension note", async () => {
    const stub: StubCtx = {
      projectRoot: stubRoot(),
      cacheDir: "/tmp/irrelevant",
      store: { lookup: async () => [], forEachRecord: noRecords },
      manifest: async () =>
        manifestOf([artifact("com.example:demo-lib:1.0.0"), artifact("com.example:nosources-lib:1.0.0")]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: () => ["degraded-to-cache-scan"],
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
      manifest: async () => manifestOf([artifact("com.example:demo-lib:1.0.0")]),
      ensureReady: async () => ({ bootstrapped: false, stale: false }),
      bootstrapWarnings: () => [],
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
      manifest: async () => manifestOf([artifact("com.example:demo-lib:1.0.0")], "gone-stale"),
      ensureReady: async () => {
        ensureReadyCalls++;
        return { bootstrapped: true, stale: false };
      },
      bootstrapWarnings: () => [],
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
    const fake: Declaration = {
      fqn: "java.util.Fresh",
      file: "java.base/java/util/Fresh.java",
      selector: "Fresh",
      kind: "class",
      visibility: "public",
      static: false,
      deprecated: false,
      signature: "public class Fresh",
    };
    const stub: StubCtx = {
      projectRoot,
      cacheDir: "/tmp/irrelevant",
      store: {
        lookup: async (fqn) =>
          fqn === "java.util.Fresh"
            ? [{ safe: "jdk%3A25", meta: artifact("jdk:25", "jdk"), records: [fake] }]
            : [],
        forEachRecord: noRecords,
      },
      manifest: async () => manifestOf([], freshHash),
      ensureReady: async () => {
        ensureReadyCalls++;
        return { bootstrapped: false, stale: false };
      },
      bootstrapWarnings: () => [],
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
