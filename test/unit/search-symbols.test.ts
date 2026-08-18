/**
 * searchSymbols scoped to ONE artifact (Task 9's world): the artifact query
 * resolves (exact coordinates or unique artifact id), that one backing is
 * parsed on demand, and the v1 tier ladder (exact selector → prefix → fuzzy)
 * runs over its records alone — stream order replaces manifest order in the
 * tiebreaks because a single artifact is streamed.
 *
 * recordsForArtifact is exercised directly through its `parseEntries` seam:
 * a counting parser proves the memo (same coordinates+listing stamp ⇒ no
 * re-parse) without touching real jars, while real-fixture runs prove the
 * source/signature provenance split. The memo is module-level and keyed by
 * coordinates, so every seam-injected test uses its OWN coordinates — a
 * shared one would memo-hit another test's parse and never call the seam.
 */
import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ListingService } from "../../src/core/listing.js";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { recordsForArtifact, type LocateDeps } from "../../src/core/query/locate.js";
import { searchSymbols } from "../../src/core/query/search-symbols.js";
import { computeDependencySetHash, writeManifest } from "../../src/index/manifest.js";
import type { DependencyArtifact } from "../../src/core/types.js";
import type { Manifest } from "../../src/index/manifest.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const JARS = join(FIXTURES, "jars");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-searchsymbols-"));
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
    version: 1,
    resolvedAt: "",
    dependencySetHash: await computeDependencySetHash(projectRoot),
    artifacts,
  });
  return openContext(projectRoot, { cacheDir: freshRoot(), onProgress: () => {} });
}

/** Hand-built LocateDeps: a real ListingService over the given artifacts plus a manifest literal. */
function deps(artifacts: DependencyArtifact[]): LocateDeps {
  const manifest: Manifest = { version: 1, resolvedAt: "", dependencySetHash: "", artifacts };
  return { listings: new ListingService(), manifest: async () => manifest };
}

/** A sources-jar copy under its own coordinates: memo-key isolation for seam tests. */
function copiedSourcesJar(coordinates: string): DependencyArtifact {
  const jar = join(freshRoot(), `${coordinates.replaceAll(":", "_")}.jar`);
  copyFileSync(DEMO_SOURCES_JAR, jar);
  return { coordinates, kind: "external", sourcesJar: jar };
}

const DEMO_SOURCES: DependencyArtifact = {
  coordinates: "com.example:demo-lib:1.0.0",
  kind: "external",
  sourcesJar: DEMO_SOURCES_JAR,
};
const NOSOURCES: DependencyArtifact = {
  coordinates: "com.example:nosources-lib:1.0.0",
  kind: "external",
  binaryJar: NOSOURCES_JAR,
};

describe("searchSymbols scoped to one artifact", () => {
  it("exact selector rows rank tier-0, with both overloads as distinct rows", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await searchSymbols(ctx, "run", { artifact: "com.example:demo-lib:1.0.0" });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]!.selector).toBe("run");
    expect(result.rows[0]!.fqn).toBe("com.example.Demo");
    expect(
      result.rows.filter((row) => row.selector === "run" && row.fqn === "com.example.Demo"),
    ).toHaveLength(2);
    // scoped: only the requested artifact's rows, never another artifact's
    expect(result.rows.every((row) => row.coordinates === "com.example:demo-lib:1.0.0")).toBe(true);
  });

  it("a prefix row ranks below the exact row (BigService m1: exact, then m10..)", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await searchSymbols(ctx, "m1", { artifact: "demo-lib" });
    const exact = result.rows.filter((row) => row.selector === "m1");
    expect(exact).toHaveLength(1);
    const firstPrefix = result.rows.findIndex(
      (row) => row.selector.startsWith("m1") && row.selector !== "m1",
    );
    expect(firstPrefix).toBeGreaterThan(result.rows.indexOf(exact[0]!));
    // every row matches the query somehow: exact/prefix or a fuzzy subsequence
    for (const row of result.rows) {
      expect(row.selector.startsWith("m1") || row.selector.includes("1")).toBe(true);
    }
  });

  it("kind filter excludes other kinds", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const fields = await searchSymbols(ctx, "NAME", { artifact: "demo-lib", kind: "field" });
    expect(fields.rows.map((row) => row.fqn)).toContain("com.example.Demo");
    const none = await searchSymbols(ctx, "run", { artifact: "demo-lib", kind: "field" });
    expect(none.rows).toHaveLength(0);
  });

  it("limit is respected", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await searchSymbols(ctx, "m", { artifact: "demo-lib", limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((row) => row.selector.startsWith("m"))).toBe(true);
  });

  it("a sources backing serves provenance source; artifact-id queries resolve", async () => {
    const ctx = await contextWith([DEMO_SOURCES]);
    const result = await searchSymbols(ctx, "run", { artifact: "demo-lib" });
    expect(result.rows[0]!.provenance).toBe("source");
    expect(result.rows[0]!.coordinates).toBe("com.example:demo-lib:1.0.0");
  });

  it("a binary backing serves provenance signature", async () => {
    const ctx = await contextWith([NOSOURCES]);
    const result = await searchSymbols(ctx, "secret", {
      artifact: "com.example:nosources-lib:1.0.0",
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.provenance === "signature")).toBe(true);
  });

  it("signatures truncate at 120 characters with an ellipsis", async () => {
    // a sourceDir artifact with one absurdly long method signature: the only
    // row's signature must come back cut at the cap, not verbatim
    const root = freshRoot();
    mkdirSync(join(root, "com/example"), { recursive: true });
    writeFileSync(
      join(root, "com/example/Big.java"),
      "package com.example;\npublic class Big {\n  public void bigSignatureMethod(" +
        "x".repeat(200) + ") {}\n}\n",
    );
    const ctx = await contextWith([
      { coordinates: "test:big-sig:1", kind: "module", sourceDir: root },
    ]);
    const result = await searchSymbols(ctx, "bigSignatureMethod", { artifact: "test:big-sig:1" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.signature.length).toBe(121);
    expect(result.rows[0]!.signature.endsWith("…")).toBe(true);
  });

  it("unknown artifact answers rows [] with a did-you-mean degraded line", async () => {
    const ctx = await contextWith([DEMO_SOURCES, NOSOURCES]);
    // `demo-li` is a fuzzy match of the id `demo-lib` (but not an exact one,
    // so the resolution misses) — the did-you-mean must name the real id
    const result = await searchSymbols(ctx, "run", { artifact: "demo-li" });
    expect(result.rows).toEqual([]);
    expect(result.degraded[0]).toMatch(/unknown artifact "demo-li" — closest: /);
    expect(result.degraded[0]).toContain("demo-lib");
  });

  it("a zero-record artifact answers rows [] with the unreadable string", async () => {
    const broken = join(freshRoot(), "broken.jar");
    writeFileSync(broken, "not a zip, just text padding to a plausible size");
    const ctx = await contextWith([
      { coordinates: "test:broken:1", kind: "external", binaryJar: broken },
    ]);
    const result = await searchSymbols(ctx, "run", { artifact: "test:broken:1" });
    expect(result.rows).toEqual([]);
    expect(result.degraded.some((line) => /unreadable|failed to list|no jar/.test(line))).toBe(true);
  });
});

describe("recordsForArtifact", () => {
  it("memoizes by coordinates+stamp: a second call does not re-parse", async () => {
    const artifact = copiedSourcesJar("test:memo:1");
    let parsedEntries = 0;
    const parseEntries = async (entries: readonly string[]) => {
      parsedEntries += entries.length;
      return entries.map((entry) => ({ entry, records: [], diagnostics: [] as string[] }));
    };
    const d = deps([artifact]);
    const first = await recordsForArtifact(d, artifact, { parseEntries });
    expect(parsedEntries).toBe(6); // the sources jar's six .java entries
    const second = await recordsForArtifact(d, artifact, { parseEntries });
    expect(parsedEntries).toBe(6); // memo hit — no second parse
    expect(second).toBe(first); // the SAME object: callers share the memoized value
  });

  it("a stamp change (rebuilt jar) invalidates the memo and re-parses", async () => {
    const artifact = copiedSourcesJar("test:rebuild:1");
    let parsedEntries = 0;
    const parseEntries = async (entries: readonly string[]) => {
      parsedEntries += entries.length;
      return entries.map((entry) => ({ entry, records: [], diagnostics: [] as string[] }));
    };
    const d = deps([artifact]);
    await recordsForArtifact(d, artifact, { parseEntries });
    expect(parsedEntries).toBe(6);
    // simulate a rebuild: the listing cache drops, the touched jar stats a NEW
    // stamp, and the records memo must follow it
    d.listings.invalidate(artifact.coordinates);
    const future = new Date(Date.now() + 5000);
    utimesSync(artifact.sourcesJar!, future, future);
    await recordsForArtifact(d, artifact, { parseEntries });
    expect(parsedEntries).toBe(12); // re-parsed after the stamp moved
  });

  it("parses every source entry with provenance source from the sources jar", async () => {
    const result = await recordsForArtifact(deps([DEMO_SOURCES]), DEMO_SOURCES);
    expect(result.provenance).toBe("source");
    expect(result.unreadable).toBeUndefined();
    // Demo's class row and its members all arrive
    expect(result.records.some((r) => r.fqn === "com.example.Demo" && r.selector === "Demo")).toBe(true);
    expect(result.records.some((r) => r.selector === "run" && r.kind === "method")).toBe(true);
    // nested Worker's class row arrives too (its members belong to it)
    expect(result.records.some((r) => r.fqn === "com.example.Demo.Worker" && r.kind === "class")).toBe(true);
  });

  it("a sourceDir backing parses its files with provenance source", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "com/example"), { recursive: true });
    writeFileSync(
      join(root, "com/example/Demo.java"),
      "package com.example;\npublic class Demo {\n  public int size() { return 1; }\n}\n",
    );
    const artifact: DependencyArtifact = { coordinates: "test:module:1", kind: "module", sourceDir: root };
    const result = await recordsForArtifact(deps([artifact]), artifact);
    expect(result.provenance).toBe("source");
    expect(result.records.some((r) => r.selector === "size" && r.kind === "method")).toBe(true);
  });

  it("a binary backing parses every class entry with provenance signature", async () => {
    const result = await recordsForArtifact(deps([NOSOURCES]), NOSOURCES);
    expect(result.provenance).toBe("signature");
    expect(result.records.some((r) => r.selector === "Hidden" && r.kind === "class")).toBe(true);
    expect(result.records.some((r) => r.selector === "secret" && r.kind === "method")).toBe(true);
  });

  it("an unreadable backing degrades to zero records + the unreadable string, never throws", async () => {
    const broken = join(freshRoot(), "broken.jar");
    writeFileSync(broken, "not a zip, just text padding to a plausible size");
    const artifact: DependencyArtifact = {
      coordinates: "test:broken:1",
      kind: "external",
      binaryJar: broken,
    };
    const result = await recordsForArtifact(deps([artifact]), artifact);
    expect(result.records).toEqual([]);
    expect(result.unreadable).toMatch(/failed to list|no jar/);
  });

  it("per-entry parse failures aggregate into unreadable (count + first labels)", async () => {
    const artifact = copiedSourcesJar("test:failparse:1");
    let seen = 0;
    const parseEntries = async (entries: readonly string[]) =>
      entries.map((entry) => {
        seen++;
        // the FIRST entry lexes badly (records empty + a diagnostic); the rest
        // parse clean-but-empty — only the failure must be counted and labeled
        return seen === 1
          ? { entry, records: [], diagnostics: [`unbalanced braces in ${entry}`] }
          : { entry, records: [], diagnostics: [] as string[] };
      });
    const result = await recordsForArtifact(deps([artifact]), artifact, { parseEntries });
    expect(result.records).toEqual([]);
    expect(result.unreadable).toMatch(/1 entries failed to parse/);
    expect(result.unreadable).toContain("unbalanced braces in");
  });
});
