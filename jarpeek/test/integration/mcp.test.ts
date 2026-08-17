/**
 * MCP server contract tests: the 9 tools spoken over the real protocol.
 *
 * The server and a real SDK `Client` sit on an `InMemoryTransport` linked
 * pair, so these exercise the exact JSON-RPC surface a host (Claude Code,
 * Cursor) sees — input schemas validated, results as text-serialized core
 * objects. Responses are pinned to committed goldens under
 * `test/golden/mcp/` (regenerate with `UPDATE_GOLDENS=1`); the `status`
 * golden is compared with volatile fields (cacheDir, resolvedAt, hashes)
 * normalized away first.
 *
 * Same harness shape as the CLI suite: a tmp project bootstrapped in-process
 * with injected resolvers, cache dir pinned via JARPEEK_CACHE_DIR — except
 * here the "subprocess" is the server object in this process, so parity with
 * `--json` is asserted against the same ctx, not a spawned peer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { findClass } from "../../src/core/query/find-class.js";
import { outline } from "../../src/core/query/outline.js";
import { readMember } from "../../src/core/query/read-member.js";
import { readSource } from "../../src/core/query/read-source.js";
import { status } from "../../src/core/query/status.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(PKG_ROOT, "test", "golden", "mcp");
const JARS = join(PKG_ROOT, "test", "fixtures", "jars");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

const SERVER_NAME = "jarpeek";
const MANIFEST_REL = join(".jarpeek", "manifest.json");

/** The 9 tools, exactly — order-independent set equality below. */
const EXPECTED_TOOLS = [
  "find_class",
  "outline",
  "read_member",
  "read_source",
  "read_resource",
  "search_symbols",
  "resolve",
  "status",
  "where",
] as const;

interface Suite {
  projectRoot: string;
  cacheDir: string;
  ctx: QueryContext;
  client: Client;
}

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

/**
 * Build a server on a linked transport pair and connect the client. Both
 * ends register for afterAll teardown so transports close and no handles
 * leak between suites.
 */
async function connect(ctx: QueryContext): Promise<Client> {
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "jarpeek-test", version: "0.0.0" });
  await client.connect(clientTransport);
  teardown.push(() => server.close(), () => client.close());
  return client;
}

const c = {} as Suite;
const lazy = {} as { projectRoot: string; ctx: QueryContext; client: Client };
const teardown: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  process.env.JARPEEK_CACHE_DIR = mkdtempSync(join(tmpdir(), "jarpeek-mcp-cache-"));

  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-mcp-project-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  const ctx = openContext(projectRoot, {
    resolvers: { gradle: async () => ({ ok: true, artifacts: demoArtifacts() }), includeJdk: false },
    cacheDir: process.env.JARPEEK_CACHE_DIR,
    onProgress: () => {},
  });
  const client = await connect(ctx);
  Object.assign(c, { projectRoot, cacheDir: process.env.JARPEEK_CACHE_DIR, ctx, client });

  // lazy suite: manifest deliberately absent until the first tool call
  const lazyRoot = mkdtempSync(join(tmpdir(), "jarpeek-mcp-lazy-"));
  writeFileSync(join(lazyRoot, "build.gradle"), "plugins { id 'java' }\n");
  const lazyCtx = openContext(lazyRoot, {
    resolvers: { gradle: async () => ({ ok: true, artifacts: demoArtifacts() }), includeJdk: false },
    cacheDir: process.env.JARPEEK_CACHE_DIR,
    onProgress: () => {},
  });
  Object.assign(lazy, { projectRoot: lazyRoot, ctx: lazyCtx, client: await connect(lazyCtx) });
});

afterAll(async () => {
  for (const closer of teardown.splice(0).reverse()) await closer().catch(() => {});
  for (const root of [c.projectRoot, lazy.projectRoot]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
  if (c.cacheDir) rmSync(c.cacheDir, { recursive: true, force: true });
});

/** Call a tool and parse its single text block as the core result object. */
async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return c.client.callTool({ name, arguments: args });
}

/** Parsed payload of a successful (isError false) tool result. */
function payload(result: CallToolResult): any {
  expect(result.isError).toBeFalsy();
  expect(result.content).toHaveLength(1);
  const block = result.content![0] as { type: string; text: string };
  expect(block.type).toBe("text");
  return JSON.parse(block.text);
}

/**
 * Golden compare: with UPDATE_GOLDENS=1 (re)write the file and pass; without
 * it, deep-equal against the committed copy.
 */
function expectGolden(name: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDENS === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, serialized);
    return;
  }
  expect(existsSync(file), `golden ${file} missing (run UPDATE_GOLDENS=1 once)`).toBe(true);
  expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Replace run- and machine-varying status fields with sentinels before the
 * golden compare: tmpdir paths, timestamps, hashes, and the whole JVM probe
 * (both its boolean and its version differ per machine — a no-JVM machine
 * answers `available: false` with no version key). Tolerates a manifest-less
 * report: every keyed-off field is optional, so absent stays absent.
 */
function normalizeStatus(result: any): any {
  const optional = (value: unknown, sentinel: string): unknown =>
    value !== undefined ? sentinel : undefined;
  return {
    ...result,
    projectRoot: "<projectRoot>",
    cacheDir: "<cacheDir>",
    ...(result.manifest !== undefined
      ? {
          manifest: {
            ...result.manifest,
            resolvedAt: optional(result.manifest.resolvedAt, "<resolvedAt>"),
            dependencySetHash: optional(result.manifest.dependencySetHash, "<hash>"),
          },
        }
      : {}),
    ...(result.jvm !== undefined
      ? {
          jvm: {
            ...result.jvm,
            // unconditional: no-JVM answers false, and whether a parseable
            // version exists at all is itself machine-dependent
            available: "<jvmAvailable>",
            version: optional(result.jvm.version, "<jvmVersion>"),
          },
        }
      : {}),
  };
}

describe("tool listing", () => {
  it("lists exactly the 9 tools, each with a JSON input schema", async () => {
    const list = await c.client.listTools();
    const names = list.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of list.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("declares the 1:1 argument surface", async () => {
    const list: ListToolsResult = await c.client.listTools();
    const props = (name: string): string[] =>
      Object.keys((list.tools.find((t) => t.name === name)!.inputSchema as any).properties ?? {}).sort();
    expect(props("find_class")).toEqual(["limit", "query"]);
    expect(props("outline")).toEqual(["fqn", "kind", "visibility"]);
    expect(props("read_member")).toEqual(["fqn", "selectors"]);
    expect(props("read_source")).toEqual(["fqn", "from", "mode", "to"]);
    expect(props("read_resource")).toEqual(["artifact", "glob"]);
    expect(props("search_symbols")).toEqual(["kind", "limit", "query"]);
    expect(props("resolve")).toEqual([]);
    expect(props("status")).toEqual([]);
    expect(props("where")).toEqual(["coordinates"]);
    const readSource = list.tools.find((t) => t.name === "read_source")!.inputSchema as any;
    expect(readSource.properties.mode.enum).toEqual(["outline", "full", "lines"]);
  });
});

describe("find_class", () => {
  it("returns the core findClass object, golden-pinned", async () => {
    const parsed = payload(await call("find_class", { query: "com.example.Demo" }));
    const expected = await findClass(c.ctx, "com.example.Demo");
    expect(parsed).toEqual(expected);
    expectGolden("find_class", parsed);
  });

  it("empty hits route through handleMiss, matching the CLI --json miss", async () => {
    const result = await call("find_class", { query: "ZzzzNoMatch" });
    expect(result.isError).toBeFalsy();
    const parsed = payload(result);
    expect(parsed.found).toBe(false);
    expect(parsed.via).toBe("negative");
    expect(parsed.searchedArtifacts).toContain("com.example:demo-lib:1.0.0");
  });
});

describe("outline", () => {
  it("returns the core outline object, golden-pinned", async () => {
    const parsed = payload(await call("outline", { fqn: "com.example.Demo" }));
    const expected = await outline(c.ctx, "com.example.Demo");
    expect(parsed).toEqual(expected);
    expectGolden("outline", parsed);
  });

  it("unknown fqn is a miss answer, never a raw error", async () => {
    const result = await call("outline", { fqn: "com.zzz.Missing" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content![0] as { text: string }).text);
    expect(parsed.found === false || Array.isArray(parsed.hits)).toBe(true);
  });
});

describe("read_member", () => {
  it("single selector golden-pinned and equal to the core result", async () => {
    const parsed = payload(
      await call("read_member", { fqn: "com.example.Demo", selectors: ["#run(String,int)"] }),
    );
    const expected = await readMember(c.ctx, "com.example.Demo", "#run(String,int)");
    expect(parsed).toEqual(expected);
    expectGolden("read_member", parsed);
  });

  it("batch selectors serve every member", async () => {
    const parsed = payload(
      await call("read_member", { fqn: "com.example.Demo", selectors: ["#run", "#NAME"] }),
    );
    // the bare #run selector expands to every run overload
    expect(parsed.members.map((m: any) => m.selector).sort()).toEqual([
      "NAME",
      "run()",
      "run(String,int)",
    ]);
  });

  it("malformed selector is a tool error, not a crash", async () => {
    const result = await call("read_member", { fqn: "com.example.Demo", selectors: ["run"] });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content![0] as { text: string }).text);
    expect(parsed.error).toContain("#");
  });
});

describe("read_source", () => {
  it("lines mode golden-pinned with exactly 2 lines", async () => {
    const parsed = payload(
      await call("read_source", { fqn: "com.example.Demo", mode: "lines", from: 2, to: 3 }),
    );
    const expected = await readSource(c.ctx, "com.example.Demo", { mode: "lines", from: 2, to: 3 });
    expect(parsed).toEqual(expected);
    expect(parsed.lines).toHaveLength(2);
    expectGolden("read_source-lines", parsed);
  });

  it("lines mode without from/to is a tool error", async () => {
    const result = await call("read_source", { fqn: "com.example.Demo", mode: "lines" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content![0] as { text: string }).text);
    expect(parsed.error).toContain("from and to");
  });
});

describe("read_resource + search_symbols + where", () => {
  it("read_resource serves text entries", async () => {
    const parsed = payload(
      await call("read_resource", { artifact: "com.example:demo-lib:1.0.0", glob: "config/*" }),
    );
    expect(parsed.entries.map((e: any) => e.path)).toContain("config/app.properties");
  });

  it("unknown artifact is a tool error", async () => {
    const result = await call("read_resource", { artifact: "no-such-artifact", glob: "*" });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content![0] as { text: string }).text).error).toContain(
      "unknown artifact",
    );
  });

  it("search_symbols ranks the exact selector", async () => {
    const parsed = payload(await call("search_symbols", { query: "run", limit: 10 }));
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows[0].selector).toBe("run");
  });

  it("where reports the unpacked dir", async () => {
    const parsed = payload(await call("where", { coordinates: "com.example:demo-lib:1.0.0" }));
    expect(parsed.dir.startsWith(join(c.cacheDir, "v1", "unpacked"))).toBe(true);
    expect(existsSync(parsed.dir)).toBe(true);
  });
});

describe("status", () => {
  it("reports manifest and index, golden-pinned modulo volatile fields", async () => {
    const parsed = payload(await call("status", {}));
    expect(parsed.manifest.present).toBe(true);
    expect(parsed.index.artifactCount).toBeGreaterThanOrEqual(2);
    expect(parsed.projectRoot).toBe(c.projectRoot);
    const expected = await status(c.ctx);
    expect({ ...parsed, jvm: expected.jvm }).toEqual({ ...expected, jvm: expected.jvm });
    expectGolden("status", normalizeStatus(parsed));
  });
});

describe("context-cost budget (the product's core promise)", () => {
  // BigService: 100 methods, 408 source lines. Its outline must fit the
  // frugal budget so an agent's first look at a class costs ~100 lines, not
  // ~400. The payload is compact JSON (one physical line), so the honest
  // line-count proxy is one per declaration row; the full-source contrast
  // proves the outline is what keeps the budget.
  const BUDGET_LINES = 120;

  it("outline of BigService stays within the budget", async () => {
    const parsed = payload(await call("outline", { fqn: "com.example.BigService" }));
    expect(parsed.rows).toHaveLength(101); // 100 methods + the class row
    expect(parsed.rows.length).toBeLessThanOrEqual(BUDGET_LINES);
  });

  it("read_source outline mode stays within the same budget", async () => {
    const parsed = payload(
      await call("read_source", { fqn: "com.example.BigService", mode: "outline" }),
    );
    expect(parsed.rows.length).toBeLessThanOrEqual(BUDGET_LINES);
  });

  it("full source blows the budget — outline is what keeps it", async () => {
    const parsed = payload(await call("read_source", { fqn: "com.example.BigService", mode: "full" }));
    expect(parsed.lineCount).toBe(408);
    expect(parsed.lineCount).toBeGreaterThan(BUDGET_LINES);
  });
});

describe("lazy bootstrap", () => {
  it("first find_class on a manifest-less project bootstraps and answers", async () => {
    expect(existsSync(join(lazy.projectRoot, MANIFEST_REL))).toBe(false);
    const result = await lazy.client.callTool({
      name: "find_class",
      arguments: { query: "com.example.Demo" },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content![0] as { text: string }).text);
    expect(parsed.hits.map((h: any) => h.fqn)).toContain("com.example.Demo");
    expect(existsSync(join(lazy.projectRoot, MANIFEST_REL))).toBe(true);
  });
});
