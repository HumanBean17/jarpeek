import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { readMember } from "../../src/core/query/read-member.js";
import { readResource, truncateUtf8 } from "../../src/core/query/read-resource.js";
import { searchSymbols } from "../../src/core/query/search-symbols.js";
import { status } from "../../src/core/query/status.js";
import { where } from "../../src/core/query/where.js";
import { SpawnError } from "../../src/util/exec.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const JARS = join(FIXTURES, "jars");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

const hasJava = !spawnSync("java", ["-version"], { stdio: "ignore" }).error;
const withJava = hasJava ? describe : describe.skip;

interface Suite {
  projectRoot: string;
  cacheDir: string;
  ctx: QueryContext;
}

const c = {} as Suite;
const noJvm = {} as Suite;
const ambiguous = {} as Suite;

function demoArtifacts(): DependencyArtifact[] {
  return [
    {
      coordinates: "com.example:demo-lib:1.0.0",
      kind: "external",
      binaryJar: DEMO_JAR,
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
  ];
}

function openSuite(artifacts: () => DependencyArtifact[]): Suite {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-tools-project-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "jarpeek-tools-cache-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  const ctx = openContext(projectRoot, {
    resolvers: { gradle: async () => ({ ok: true, artifacts: artifacts() }), includeJdk: false },
    cacheDir,
    onProgress: () => {},
  });
  return { projectRoot, cacheDir, ctx };
}

const suites: Suite[] = [];

beforeAll(() => {
  Object.assign(c, openSuite(demoArtifacts));
  // separate cache dir so the decompile disk cache is empty for the no-jvm scenario
  Object.assign(noJvm, openSuite(demoArtifacts));
  Object.assign(
    ambiguous,
    openSuite(() => [
      ...demoArtifacts(),
      {
        coordinates: "com.other:demo-lib:2",
        kind: "external",
        binaryJar: NOSOURCES_JAR,
        provenance: "signature",
        warnings: [],
      },
    ]),
  );
  suites.push(c, noJvm, ambiguous);
});

afterAll(() => {
  for (const s of suites) {
    rmSync(s.projectRoot, { recursive: true, force: true });
    rmSync(s.cacheDir, { recursive: true, force: true });
  }
});

describe("readMember", () => {
  it("sourced batch: javadoc lines included, field spans its declaration", async () => {
    const result = await readMember(c.ctx, "com.example.Demo", "#run(String,int),#NAME");
    expect(result.fqn).toBe("com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    expect(result.members).toHaveLength(2);

    const run = result.members.find((m) => m.selector === "run(String,int)")!;
    expect(run, "run(String,int) member present").toBeDefined();
    expect(run.lines[0]!.trim()).toBe("/**");
    expect(run.startLine).toBe(11); // javadocStart from the Task 4 golden
    expect(run.endLine).toBe(21);
    expect(run.javadoc).toBeDefined();
    expect(run.javadoc![0]!.trim()).toBe("/**");
    expect(run.signature).toBe("public Object run(String,int)");

    const name = result.members.find((m) => m.selector === "NAME")!;
    expect(name, "NAME member present").toBeDefined();
    expect(name.startLine).toBe(9);
    expect(name.endLine).toBe(9);
    expect(name.lines).toEqual(['    private static final String NAME = "demo";']);
    expect(name.javadoc).toBeUndefined();
    expect(result.misses).toEqual([]);
  });

  it("bare selector expands overloads with disambiguated selectors", async () => {
    const result = await readMember(c.ctx, "com.example.Demo", "#run");
    expect(result.members.map((m) => m.selector).sort()).toEqual(["run()", "run(String,int)"]);
  });

  it("partial miss: other selectors still served", async () => {
    const result = await readMember(c.ctx, "com.example.Demo", "#run,#doesNotExist");
    expect(result.members).toHaveLength(2);
    expect(result.misses).toEqual([{ selector: "#doesNotExist", reason: "no matching declaration" }]);
  });

  it("malformed selector throws SelectorError for the whole call", async () => {
    await expect(readMember(c.ctx, "com.example.Demo", "#ok,#bad selector!")).rejects.toThrow(
      /malformed selector|Usage:/,
    );
  });

  withJava("decompile path", () => {
    it("binary-only artifact decompiles; second read hits the cache", async () => {
      const first = await readMember(c.ctx, "com.example.nosources.Hidden", "#secret()");
      expect(first.provenance).toBe("decompiled");
      expect(first.coordinates).toBe("com.example:nosources-lib:1.0.0");
      const member = first.members[0]!;
      expect(member.selector).toBe("secret()");
      expect(member.lines.length).toBeGreaterThan(0);
      expect(member.lines.join("\n")).toContain("secret");
      expect(member.startLine).toBeGreaterThan(0);

      const exec = vi.fn(async () => {
        throw new Error("java must not run on a cache hit");
      });
      const second = await readMember(c.ctx, "com.example.nosources.Hidden", "#secret()", { exec });
      expect(exec).not.toHaveBeenCalled();
      expect(second.provenance).toBe("decompiled");
      expect(second.members[0]!.lines).toEqual(member.lines);
    });
  });

  it("no-jvm degrades to signature pseudo-members with a miss reason", async () => {
    const exec = async () => {
      throw new SpawnError("java", { code: "ENOENT", message: "spawn java ENOENT" } as NodeJS.ErrnoException);
    };
    const result = await readMember(noJvm.ctx, "com.example.nosources.Hidden", "#secret()", { exec });
    expect(result.provenance).toBe("signature");
    expect(result.members).toHaveLength(1);
    const member = result.members[0]!;
    expect(member.selector).toBe("secret()");
    expect(member.signature).toBe("public java.lang.String secret()");
    expect(member.lines).toEqual(["public java.lang.String secret()"]);
    expect(member.startLine).toBe(0);
    expect(member.endLine).toBe(0);
    expect(result.misses).toEqual([
      { selector: "#secret()", reason: "no-jvm (decompile unavailable)" },
    ]);
  });

  it("noDecompile jdk artifact serves signature rows with the jdk miss reason", async () => {
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
          selector: "size",
          kind: "method",
          visibility: "public",
          static: false,
          deprecated: false,
          signature: "public int size()",
        },
      ],
    );
    const result = await readMember(c.ctx, "jdk.fake.Fake", "#size()");
    expect(result.provenance).toBe("signature");
    expect(result.members[0]!.lines).toEqual(["public int size()"]);
    expect(result.members[0]!.startLine).toBe(0);
    expect(result.misses).toEqual([{ selector: "#size()", reason: "jdk: decompilation out of scope" }]);
  });
});

describe("readResource", () => {
  it("text entry content from the binary jar", async () => {
    const result = await readResource(c.ctx, "com.example:demo-lib:1.0.0", "config/*");
    expect(result.artifact).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.path).toBe("config/app.properties");
    expect(entry.content).toBe("key=value");
    expect(entry.binary).toBeUndefined();
  });

  it("META-INF/services entries are text", async () => {
    const result = await readResource(c.ctx, "com.example:demo-lib:1.0.0", "META-INF/services/*");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.path).toBe("META-INF/services/com.example.Demo");
    expect(result.entries[0]!.content).toBe("com.example.Demo\n");
  });

  it("class entries are binary with a note and no content; artifact-id query resolves", async () => {
    const result = await readResource(c.ctx, "demo-lib", "**/*.class");
    expect(result.entries.length).toBe(9);
    for (const entry of result.entries) {
      expect(entry.binary).toBe(true);
      expect(entry.note).toContain("binary");
      expect(entry.content).toBeUndefined();
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it("png resource is binary even though the fixture is tiny", async () => {
    const result = await readResource(c.ctx, "demo-lib", "logo.png");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.binary).toBe(true);
  });

  it("glob matching nothing yields empty entries, not an error", async () => {
    const result = await readResource(c.ctx, "com.example:demo-lib:1.0.0", "no/such/**");
    expect(result.entries).toEqual([]);
  });

  it("ambiguous artifact-id throws listing the coordinates", async () => {
    const err = await readResource(ambiguous.ctx, "demo-lib", "config/*").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ambiguous/);
    expect((err as Error).message).toContain("com.example:demo-lib:1.0.0");
    expect((err as Error).message).toContain("com.other:demo-lib:2");
  });

  it("unknown artifact query throws", async () => {
    await expect(readResource(c.ctx, "no-such-artifact", "*")).rejects.toThrow(/unknown artifact/);
  });

  it("text truncation backs off to a UTF-8 codepoint boundary", () => {
    // é is 2 bytes (0xC3 0xA9); a raw 3-byte cut would split the second é
    const buf = Buffer.from("é".repeat(4), "utf8");
    expect(buf.length).toBe(8);
    const cut = truncateUtf8(buf, 3);
    expect(cut).toBe("é");
    expect(Buffer.byteLength(cut, "utf8")).toBe(2);
    // whole-buffer and exactly-at-limit cases pass through
    expect(truncateUtf8(Buffer.from("abc"), 10)).toBe("abc");
    expect(truncateUtf8(Buffer.from("abc"), 3)).toBe("abc");
  });
});

describe("searchSymbols", () => {
  it("exact selector hits rank first", async () => {
    const result = await searchSymbols(c.ctx, "run");
    expect(result.rows[0]!.selector).toBe("run");
    expect(result.rows[0]!.fqn).toBe("com.example.Demo");
    expect(result.rows[0]!.coordinates).toBe("com.example:demo-lib:1.0.0");
    // both overloads surface as distinct rows
    expect(result.rows.filter((r) => r.selector === "run" && r.fqn === "com.example.Demo")).toHaveLength(2);
  });

  it("kind filter excludes other kinds", async () => {
    const fields = await searchSymbols(c.ctx, "NAME", { kind: "field" });
    expect(fields.rows.map((r) => r.fqn)).toContain("com.example.Demo");
    const none = await searchSymbols(c.ctx, "run", { kind: "field" });
    expect(none.rows).toHaveLength(0);
  });

  it("limit is respected", async () => {
    const result = await searchSymbols(c.ctx, "m", { limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((r) => r.selector.startsWith("m"))).toBe(true);
  });

  it("signatures truncate at 120 characters with an ellipsis", async () => {
    const artifact = {
      coordinates: "com.example:big-sig:1",
      kind: "cache-scan" as const,
      provenance: "source" as const,
      warnings: [],
    };
    await c.ctx.store.writeArtifact(artifact, [
      {
        fqn: "com.example.bigsig.BigSig",
        file: "x",
        selector: "bigSignatureMethod",
        kind: "method",
        visibility: "public",
        static: false,
        deprecated: false,
        signature: "public void bigSignatureMethod(" + "x".repeat(200) + ")",
      },
    ]);
    // search is scoped to the manifest's artifact set: register the shard there
    const manifestPath = join(c.projectRoot, ".jarpeek", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { artifacts: unknown[] };
    manifest.artifacts.push(artifact);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await searchSymbols(c.ctx, "bigSignatureMethod");
    expect(result.rows[0]!.signature.length).toBe(121);
    expect(result.rows[0]!.signature.endsWith("…")).toBe(true);
  });
});

describe("status", () => {
  it("reports manifest, index, and jvm after bootstrap", async () => {
    const result = await status(c.ctx);
    expect(result.projectRoot).toBe(c.projectRoot);
    expect(result.cacheDir).toBe(c.cacheDir);
    expect(result.manifest.present).toBe(true);
    expect(result.manifest.artifactCount).toBeGreaterThanOrEqual(2);
    expect(result.manifest.resolvedAt).toBeDefined();
    expect(result.manifest.stale).toBe(false);
    expect(result.index.artifactCount).toBeGreaterThanOrEqual(2);
    expect(result.index.fqnCount).toBeGreaterThan(5);
    expect(result.jvm.available).toBe(hasJava);
    if (hasJava) expect(result.jvm.version).toMatch(/\d/);
    expect(Array.isArray(result.degraded)).toBe(true);
  });
});

describe("where", () => {
  it("demo-lib unpacks its sources jar once under v1/unpacked", async () => {
    const first = await where(c.ctx, "demo-lib");
    expect(first.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(first.dir.startsWith(join(c.cacheDir, "v1", "unpacked"))).toBe(true);
    expect(existsSync(join(first.dir, "com", "example", "Demo.java"))).toBe(true);
    expect(first.fileCount).toBe(6); // the sources jar's six .java entries

    const marker = join(first.dir, ".jarpeek-unpacked");
    expect(existsSync(marker)).toBe(true);
    const markerMtime = statSync(marker).mtimeMs;

    const second = await where(c.ctx, "demo-lib");
    expect(second.dir).toBe(first.dir);
    expect(second.fileCount).toBe(first.fileCount);
    expect(statSync(marker).mtimeMs).toBe(markerMtime);
  });

  it("binary-only artifact reports the jar path with a no-sources note", async () => {
    const result = await where(c.ctx, "nosources-lib");
    expect(result.coordinates).toBe("com.example:nosources-lib:1.0.0");
    expect(result.dir).toBe(NOSOURCES_JAR);
    expect(result.note).toContain("no sources jar");
  });

  it("unknown artifact query throws", async () => {
    await expect(where(c.ctx, "no-such-artifact")).rejects.toThrow(/unknown artifact/);
  });
});

describe("read_resource / where honesty parity", () => {
  it("a stale-served manifest carries stale:true and a degraded entry on both tools", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-parity-project-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "jarpeek-parity-cache-"));
    suites.push({ projectRoot, cacheDir, ctx: undefined as unknown as QueryContext });
    try {
      writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
      let impl: () => Promise<{ ok: boolean; artifacts: DependencyArtifact[] }> = async () => ({
        ok: true,
        artifacts: demoArtifacts(),
      });
      const ctx = openContext(projectRoot, {
        resolvers: { gradle: async () => impl(), includeJdk: false },
        cacheDir,
        onProgress: () => {},
      });
      await readResource(ctx, "demo-lib", "config/*"); // bootstrap

      // build file moves, re-resolve fails: the stale index is served
      const gradle = join(projectRoot, "build.gradle");
      writeFileSync(gradle, "plugins { id 'java' }\n// moved\n");
      const future = new Date(Date.now() + 60_000);
      utimesSync(gradle, future, future);
      impl = async () => {
        throw new Error("offline");
      };

      const resource = await readResource(ctx, "demo-lib", "config/*");
      expect(resource.entries[0]!.content).toBe("key=value");
      expect(resource.stale).toBe(true);
      expect(resource.degraded.some((d) => d.includes("stale"))).toBe(true);

      const location = await where(ctx, "demo-lib");
      expect(location.stale).toBe(true);
      expect(location.degraded.some((d) => d.includes("stale"))).toBe(true);
    } finally {
      // cleaned up via suites in afterAll
    }
  });
});
