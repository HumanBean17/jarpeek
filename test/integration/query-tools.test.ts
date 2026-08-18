import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { readMember } from "../../src/core/query/read-member.js";
import { readResource, truncateUtf8 } from "../../src/core/query/read-resource.js";
import { searchSymbols } from "../../src/core/query/search-symbols.js";
import { status } from "../../src/core/query/status.js";
import { where } from "../../src/core/query/where.js";
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

/**
 * One backing per artifact (the fixture-manifest rule): demo-lib declares
 * its SOURCES jar so locate parses source records; nosources-lib is
 * binary-only. (A both-jars artifact lists binary-first and would answer
 * from bytecode.)
 */
function demoArtifacts(): DependencyArtifact[] {
  return [
    {
      coordinates: "com.example:demo-lib:1.0.0",
      kind: "external",
      sourcesJar: DEMO_SOURCES_JAR,
    },
    {
      coordinates: "com.example:nosources-lib:1.0.0",
      kind: "external",
      binaryJar: NOSOURCES_JAR,
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
  // separate context so the decompile memo is cold for the no-jvm scenario
  Object.assign(noJvm, openSuite(demoArtifacts));
  Object.assign(
    ambiguous,
    openSuite(() => [
      ...demoArtifacts(),
      {
        coordinates: "com.other:demo-lib:2",
        kind: "external",
        binaryJar: NOSOURCES_JAR,
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
  for (const closer of mcpTeardown.splice(0).reverse()) void closer().catch(() => {});
});

/** Server+client pairs closed in afterAll so transports never leak between suites. */
const mcpTeardown: Array<() => Promise<unknown>> = [];

/** A connected MCP client over the given context (InMemoryTransport pair). */
async function connectClient(ctx: QueryContext): Promise<Client> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "jarpeek-tools-test", version: "0.0.0" });
  await client.connect(clientTransport);
  mcpTeardown.push(() => server.close(), () => client.close());
  return client;
}

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

  // declared BEFORE the withJava block: a successful decompile memoizes the
  // class for the whole process, and this test needs a real spawn failure —
  // it must run while the memo for Hidden is still cold. The failed attempt
  // memoizes nothing, so the withJava block above it stays honest too.
  it("no-jvm degrades to signature pseudo-members with a miss reason", async () => {
    // exec injection died with the ResolveContentOptions.exec removal; a real
    // spawn failure is forced by pointing PATH and JAVA_HOME at an empty dir
    const emptyBin = mkdtempSync(join(tmpdir(), "jarpeek-empty-bin-"));
    const prevPath = process.env.PATH;
    const prevJavaHome = process.env.JAVA_HOME;
    process.env.PATH = emptyBin;
    process.env.JAVA_HOME = emptyBin;
    try {
      const result = await readMember(noJvm.ctx, "com.example.nosources.Hidden", "#secret()");
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
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = prevJavaHome;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  withJava("decompile path", () => {
    it("binary-only artifact decompiles; second read hits the memo", async () => {
      const first = await readMember(c.ctx, "com.example.nosources.Hidden", "#secret()");
      expect(first.provenance).toBe("decompiled");
      expect(first.coordinates).toBe("com.example:nosources-lib:1.0.0");
      const member = first.members[0]!;
      expect(member.selector).toBe("secret()");
      expect(member.lines.length).toBeGreaterThan(0);
      expect(member.lines.join("\n")).toContain("secret");
      expect(member.startLine).toBeGreaterThan(0);

      // the memo (not a disk cache) serves the repeat: the second read needs
      // no JVM round-trip and yields identical lines
      const second = await readMember(c.ctx, "com.example.nosources.Hidden", "#secret()");
      expect(second.provenance).toBe("decompiled");
      expect(second.members[0]!.lines).toEqual(member.lines);
    });
  });

  it("noDecompile jdk artifact serves signature rows with the jdk miss reason", async () => {
    // listing-world port: a jdk-kind artifact whose binary jar carries the
    // class and whose noDecompile flag skips the decompile rung
    const jdkSuite = openSuite(() => [
      {
        coordinates: "jdk:fake",
        kind: "jdk" as const,
        binaryJar: NOSOURCES_JAR,
        noDecompile: true,
      },
    ]);
    suites.push(jdkSuite);
    const result = await readMember(jdkSuite.ctx, "com.example.nosources.Hidden", "#secret()");
    expect(result.provenance).toBe("signature");
    expect(result.members[0]!.lines).toEqual([result.members[0]!.signature]);
    expect(result.members[0]!.startLine).toBe(0);
    expect(result.misses).toEqual([{ selector: "#secret()", reason: "jdk: decompilation out of scope" }]);
  });
});

describe("readResource", () => {
  // the resource half reads the artifact's binary jar directly (readResource
  // does not go through locate), so this describe uses its own suite where
  // demo-lib carries the binary jar
  const res = {} as Suite;

  beforeAll(() => {
    Object.assign(
      res,
      openSuite(() => [
        {
          coordinates: "com.example:demo-lib:1.0.0",
          kind: "external",
          binaryJar: DEMO_JAR,
          sourcesJar: DEMO_SOURCES_JAR,
          provenance: "source",
        },
        { coordinates: "com.example:nosources-lib:1.0.0", kind: "external", binaryJar: NOSOURCES_JAR },
      ]),
    );
    suites.push(res);
  });

  it("text entry content from the binary jar", async () => {
    const result = await readResource(res.ctx, "com.example:demo-lib:1.0.0", "config/*");
    expect(result.artifact).toBe("com.example:demo-lib:1.0.0");
    expect(result.provenance).toBe("source");
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.path).toBe("config/app.properties");
    expect(entry.content).toBe("key=value");
    expect(entry.binary).toBeUndefined();
  });

  it("META-INF/services entries are text", async () => {
    const result = await readResource(res.ctx, "com.example:demo-lib:1.0.0", "META-INF/services/*");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.path).toBe("META-INF/services/com.example.Demo");
    expect(result.entries[0]!.content).toBe("com.example.Demo\n");
  });

  it("class entries are binary with a note and no content; artifact-id query resolves", async () => {
    const result = await readResource(res.ctx, "demo-lib", "**/*.class");
    expect(result.entries.length).toBe(9);
    for (const entry of result.entries) {
      expect(entry.binary).toBe(true);
      expect(entry.note).toContain("binary");
      expect(entry.content).toBeUndefined();
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it("png resource is binary even though the fixture is tiny", async () => {
    const result = await readResource(res.ctx, "demo-lib", "logo.png");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.binary).toBe(true);
  });

  it("glob matching nothing yields empty entries, not an error", async () => {
    const result = await readResource(res.ctx, "com.example:demo-lib:1.0.0", "no/such/**");
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
    await expect(readResource(res.ctx, "no-such-artifact", "*")).rejects.toThrow(/unknown artifact/);
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
    const result = await searchSymbols(c.ctx, "run", { artifact: "demo-lib" });
    expect(result.rows[0]!.selector).toBe("run");
    expect(result.rows[0]!.fqn).toBe("com.example.Demo");
    expect(result.rows[0]!.coordinates).toBe("com.example:demo-lib:1.0.0");
    // both overloads surface as distinct rows
    expect(result.rows.filter((r) => r.selector === "run" && r.fqn === "com.example.Demo")).toHaveLength(2);
  });

  it("kind filter excludes other kinds", async () => {
    const fields = await searchSymbols(c.ctx, "NAME", { artifact: "demo-lib", kind: "field" });
    expect(fields.rows.map((r) => r.fqn)).toContain("com.example.Demo");
    const none = await searchSymbols(c.ctx, "run", { artifact: "demo-lib", kind: "field" });
    expect(none.rows).toHaveLength(0);
  });

  it("limit is respected", async () => {
    const result = await searchSymbols(c.ctx, "m", { artifact: "demo-lib", limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((r) => r.selector.startsWith("m"))).toBe(true);
  });

  it("scoping: a nosources-lib query never answers demo-lib rows", async () => {
    const result = await searchSymbols(c.ctx, "secret", {
      artifact: "com.example:nosources-lib:1.0.0",
    });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.coordinates === "com.example:nosources-lib:1.0.0")).toBe(true);
    expect(result.rows.every((r) => r.provenance === "signature")).toBe(true);
  });

  it("unknown artifact answers rows [] with a did-you-mean degraded line", async () => {
    const result = await searchSymbols(c.ctx, "run", { artifact: "demo-li" });
    expect(result.rows).toEqual([]);
    expect(result.degraded[0]).toMatch(/unknown artifact "demo-li" — closest: /);
    expect(result.degraded[0]).toContain("demo-lib");
  });
});

describe("search_symbols MCP schema", () => {
  it("a call without artifact is a tool error from schema validation", async () => {
    const client = await connectClient(c.ctx);
    const result = await client.callTool({ name: "search_symbols", arguments: { query: "run" } });
    expect(result.isError).toBe(true);
    // schema rejections surface as an MCP-level error text, not the {error} JSON
    const text = (result.content![0] as { text: string }).text;
    expect(text).toMatch(/validation error/);
    expect(text).toMatch(/artifact/);
  });

  it("a call with artifact serves rows", async () => {
    const client = await connectClient(c.ctx);
    const result = await client.callTool({
      name: "search_symbols",
      arguments: { query: "run", artifact: "demo-lib", limit: 10 },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content![0] as { text: string }).text);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows[0].selector).toBe("run");
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
      // the resource-half shape: demo-lib with its binary jar carries the
      // config entry this test reads
      let impl: () => Promise<{ ok: boolean; artifacts: DependencyArtifact[] }> = async () => ({
        ok: true,
        artifacts: [
          { coordinates: "com.example:demo-lib:1.0.0", kind: "external", binaryJar: DEMO_JAR },
          { coordinates: "com.example:nosources-lib:1.0.0", kind: "external", binaryJar: NOSOURCES_JAR },
        ],
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
