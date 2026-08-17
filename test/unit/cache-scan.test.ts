import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanCaches } from "../../src/resolver/cache-scan.js";

/** Every test gets its own throwaway root holding an `m2/` and a `gradle/`. */
let root: string | undefined;

function scratch(): { m2: string; gradle: string } {
  root = mkdtempSync(join(tmpdir(), "jarpeek-cachescan-"));
  return { m2: join(root, "m2", "repository"), gradle: join(root, "gradle", "modules-2") };
}

/** Create `…/jar` (and a sibling `…-sources.jar`) with tiny placeholder bytes. */
function jar(path: string, sources = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "PK");
  if (sources) writeFileSync(path.replace(/\.jar$/, "-sources.jar"), "PK");
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("scanCaches", () => {
  it("keeps the highest version per g:a with a multiple-versions warning (m2)", async () => {
    const { m2, gradle } = scratch();
    jar(join(m2, "org/a/lib/1.0.0/lib-1.0.0.jar"), true);
    jar(join(m2, "org/a/lib/2.0.0/lib-2.0.0.jar"));

    const { artifacts, warnings } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    const lib = artifacts.find((a) => a.coordinates === "org.a:lib:2.0.0");
    expect(lib).toBeDefined();
    expect(lib?.kind).toBe("cache-scan");
    expect(lib?.configuration).toBeUndefined();
    expect(lib?.sourcesJar).toBeUndefined();
    expect(lib?.provenance).toBe("signature");
    expect(lib?.warnings).toEqual([
      "multiple-versions:org.a:lib (kept 2.0.0, also saw 1.0.0)",
    ]);
    expect(artifacts.find((a) => a.coordinates === "org.a:lib:1.0.0")).toBeUndefined();
    // ambiguity warnings ride on the artifact, not the global array
    expect(warnings).toEqual([]);
  });

  it("pairs a sibling -sources.jar and marks provenance source (m2)", async () => {
    const { m2, gradle } = scratch();
    jar(join(m2, "com/b/c/1.0/c-1.0.jar"), true);

    const { artifacts, warnings } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].coordinates).toBe("com.b:c:1.0");
    expect(artifacts[0].binaryJar).toBe(join(m2, "com/b/c/1.0/c-1.0.jar"));
    expect(artifacts[0].sourcesJar).toBe(join(m2, "com/b/c/1.0/c-1.0-sources.jar"));
    expect(artifacts[0].provenance).toBe("source");
    expect(artifacts[0].warnings).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("parses the gradle modules-2 hash-directory layout", async () => {
    const { m2, gradle } = scratch();
    jar(join(gradle, "com.g/art/0.9/abc123/art-0.9.jar"));

    const { artifacts } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].coordinates).toBe("com.g:art:0.9");
    expect(artifacts[0].binaryJar).toBe(join(gradle, "com.g/art/0.9/abc123/art-0.9.jar"));
  });

  it("pairs gradle sources jars across different hash directories", async () => {
    const { m2, gradle } = scratch();
    jar(join(gradle, "com.g/art/0.9/abc123/art-0.9.jar"));
    jar(join(gradle, "com.g/art/0.9/def456/art-0.9-sources.jar"));

    const { artifacts } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].sourcesJar).toBe(join(gradle, "com.g/art/0.9/def456/art-0.9-sources.jar"));
    expect(artifacts[0].provenance).toBe("source");
  });

  it("merges duplicate coordinates across roots with m2 winning", async () => {
    const { m2, gradle } = scratch();
    jar(join(m2, "com/dup/d/1.2/d-1.2.jar"));
    jar(join(gradle, "com.dup/d/1.2/a1b2c3/d-1.2.jar"), true);

    const { artifacts } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    const dups = artifacts.filter((a) => a.coordinates === "com.dup:d:1.2");
    expect(dups).toHaveLength(1);
    expect(dups[0].binaryJar).toBe(join(m2, "com/dup/d/1.2/d-1.2.jar"));
    // the gradle-only sources jar still pairs onto the merged artifact
    expect(dups[0].sourcesJar).toBe(join(gradle, "com.dup/d/1.2/a1b2c3/d-1.2-sources.jar"));
    expect(dups[0].provenance).toBe("source");
  });

  it("skips javadoc jars, checksums, metadata files, and non-jars", async () => {
    const { m2, gradle } = scratch();
    const dir = join(m2, "org/a/lib/2.0.0");
    jar(join(dir, "lib-2.0.0.jar"));
    jar(join(dir, "lib-2.0.0-javadoc.jar"));
    writeFileSync(join(dir, "lib-2.0.0.jar.sha1"), "abc");
    writeFileSync(join(dir, "lib-2.0.0.pom"), "<project/>");
    writeFileSync(join(m2, "org/a/lib/maven-metadata.xml"), "<metadata/>");
    writeFileSync(join(m2, "org/a/lib/maven-metadata-local.xml"), "<metadata/>");
    writeFileSync(join(m2, "org/a/lib/2.0.0/lib-2.0.0.jar.lastUpdated"), "x");

    const { artifacts } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    expect(artifacts.map((a) => a.coordinates)).toEqual(["org.a:lib:2.0.0"]);
  });

  it("stops walking past maxEntries and reports cache-scan-truncated", async () => {
    const { m2, gradle } = scratch();
    // 6 unrelated one-jar coordinates
    for (let i = 1; i <= 6; i++) {
      jar(join(m2, `com/t${i}/t${i}/1.0/t${i}-1.0.jar`));
    }

    const { artifacts, warnings } = await scanCaches({ m2Dir: m2, gradleDir: gradle, maxEntries: 3 });

    expect(artifacts.length).toBeLessThanOrEqual(3);
    const truncated = warnings.find((w) => w.startsWith("cache-scan-truncated:"));
    expect(truncated).toBeDefined();
    expect(Number(truncated!.split(":")[1])).toBe(4);
  });

  it("carries m2's skipped-file visits into the shared budget across walks", async () => {
    const { m2, gradle } = scratch();
    // 2 coordinates × (jar + .sha1) = 4 m2 files visited, only 2 matched
    for (let i = 1; i <= 2; i++) {
      const dir = join(m2, `com/s${i}`, `s${i}`, "1.0");
      jar(join(dir, `s${i}-1.0.jar`));
      writeFileSync(join(dir, `s${i}-1.0.jar.sha1`), "abc");
    }
    // 6 gradle jars: matched-count arithmetic leaves budget 6 (no trip);
    // visited-count leaves 4, tripping at the 5th gradle file → 4 + 5 = 9
    for (let i = 1; i <= 6; i++) {
      jar(join(gradle, `com.g/g${i}/1.0/a${i}b2c3/g${i}-1.0.jar`));
    }

    const { artifacts, warnings } = await scanCaches({ m2Dir: m2, gradleDir: gradle, maxEntries: 8 });

    expect(warnings).toEqual(["cache-scan-truncated:9"]);
    const gradleCoords = artifacts.filter((a) => a.coordinates.startsWith("com.g:"));
    expect(gradleCoords.length).toBeLessThanOrEqual(4);
    expect(artifacts.length).toBeLessThanOrEqual(6);
  });

  it("carries leftover m2 visit budget into the gradle walk", async () => {
    const { m2, gradle } = scratch();
    // 2 coordinates × (jar + .sha1) = 4 m2 files visited, 2 matched
    for (let i = 1; i <= 2; i++) {
      const dir = join(m2, `com/s${i}`, `s${i}`, "1.0");
      jar(join(dir, `s${i}-1.0.jar`));
      writeFileSync(join(dir, `s${i}-1.0.jar.sha1`), "abc");
    }
    jar(join(gradle, "com.g/only/1.0/aaaa/only-1.0.jar"));

    // old arithmetic (budget 20000-2) fits everything; correct accounting
    // (budget 20000-4) fits too — this pins that neither walk trips
    const { artifacts, warnings } = await scanCaches({ m2Dir: m2, gradleDir: gradle, maxEntries: 20000 });

    expect(warnings).toEqual([]);
    expect(artifacts.map((a) => a.coordinates).sort()).toEqual([
      "com.g:only:1.0",
      "com.s1:s1:1.0",
      "com.s2:s2:1.0",
    ]);
  });

  it("sorts versions numerically at each dotted segment before falling back lexicographic", async () => {
    const { m2, gradle } = scratch();
    jar(join(m2, "org/n/nat/1.10.0/nat-1.10.0.jar"));
    jar(join(m2, "org/n/nat/1.9.0/nat-1.9.0.jar"));
    jar(join(m2, "org/n/nat/1.10.0.RC1/nat-1.10.0.RC1.jar"));

    const { artifacts } = await scanCaches({ m2Dir: m2, gradleDir: gradle });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].coordinates).toBe("org.n:nat:1.10.0");
  });

  it("returns empty results for nonexistent roots without throwing", async () => {
    const { artifacts, warnings } = await scanCaches({
      m2Dir: "/nonexistent/jarpeek-m2",
      gradleDir: "/nonexistent/jarpeek-gradle",
    });
    expect(artifacts).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
