/**
 * MCP server contract tests: the 9 tools spoken over the real protocol.
 *
 * The server and a real SDK `Client` sit on an `InMemoryTransport` linked
 * pair, so these exercise the exact JSON-RPC surface a host (Claude Code,
 * Cursor) sees — input schemas validated, results as text-serialized core
 * objects. Responses are pinned to committed goldens under
 * `test/golden/mcp/` (regenerate with `UPDATE_GOLDENS=1`); the `status`
 * golden is compared with volatile fields (resolvedAt, hashes, the jvm
 * probe) normalized away first.
 *
 * Same harness shape as the CLI suite: a tmp project bootstrapped in-process
 * with injected resolvers — except here the "subprocess" is the server
 * object in this process, so parity with `--json` is asserted against the
 * same ctx, not a spawned peer.
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
  ctx: QueryContext;
  client: Client;
}

/**
 * One backing per artifact (the fixture-manifest rule): demo-lib declares
 * its SOURCES jar so locate parses source records; nosources-lib is
 * binary-only; demo-lib-bin carries the binary jar for the resource-half
 * cases (read_resource reads the runtime jar directly, not through locate).
 * (A both-jars artifact lists binary-first and would answer from bytecode →
 * decompile.)
 */
function demoArtifacts(): DependencyArtifact[] {
  return [
    {
      coordinates: "com.example:demo-lib:1.0.0",
      kind: "external",
      sourcesJar: DEMO_SOURCES_JAR,
    },
    {
      coordinates: "com.example:demo-lib-bin:1.0.0",
      kind: "external",
      binaryJar: DEMO_JAR,
    },
    {
      coordinates: "com.example:nosources-lib:1.0.0",
      kind: "external",
      binaryJar: NOSOURCES_JAR,
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
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-mcp-project-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  const ctx = openContext(projectRoot, {
    resolvers: { gradle: async () => ({ ok: true, artifacts: demoArtifacts() }), includeJdk: false },
    onNotice: () => {},
  });
  const client = await connect(ctx);
  Object.assign(c, { projectRoot, ctx, client });

  // lazy suite: manifest deliberately absent until the first tool call
  const lazyRoot = mkdtempSync(join(tmpdir(), "jarpeek-mcp-lazy-"));
  writeFileSync(join(lazyRoot, "build.gradle"), "plugins { id 'java' }\n");
  const lazyCtx = openContext(lazyRoot, {
    resolvers: { gradle: async () => ({ ok: true, artifacts: demoArtifacts() }), includeJdk: false },
    onNotice: () => {},
  });
  Object.assign(lazy, { projectRoot: lazyRoot, ctx: lazyCtx, client: await connect(lazyCtx) });
});

afterAll(async () => {
  for (const closer of teardown.splice(0).reverse()) await closer().catch(() => {});
  for (const root of [c.projectRoot, lazy.projectRoot]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
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
 * golden compare: the tmpdir project root, timestamps, hashes, and the whole
 * JVM probe.
 * The jvm block is normalized unconditionally — both values AND their
 * presence differ per machine (no-JVM answers `available: false` with no
 * version key; an unparseable `-version` answers `available: true` with no
 * version key), so sentinels replace whatever was reported, missing keys
 * included. Manifest fields stay presence-optional: the suite bootstraps a
 * manifest deterministically, so their presence does not vary by machine.
 */
function normalizeStatus(result: any): any {
  const optional = (value: unknown, sentinel: string): unknown =>
    value !== undefined ? sentinel : undefined;
  return {
    ...result,
    projectRoot: "<projectRoot>",
    // the effective roots are machine facts (this machine's home); only
    // their shape and source layer are the contract under test
    ...(result.resolver !== undefined
      ? {
          resolver: {
            m2Root: { path: "<m2Root>", source: "<m2Source>" },
            gradleCacheRoot: { path: "<gradleRoot>", source: "<gradleSource>" },
          },
        }
      : {}),
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
            available: "<jvmAvailable>",
            version: "<jvmVersion>",
          },
        }
      : {}),
  };
}

/**
 * find_class hits carry the provenance promise, which reads JVM availability
 * (`source` artifacts aside) — the same machine variance status normalizes.
 * Source promises are stable and stay pinned; everything else becomes a
 * sentinel so a no-JVM CI and a dev laptop pin the same golden.
 */
function normalizeFindClassProvenance(result: any): any {
  return {
    ...result,
    hits: result.hits.map((hit: any) =>
      hit.provenance === "source" ? hit : { ...hit, provenance: "<promise>" },
    ),
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
    expect(props("outline")).toEqual(["fqn", "kind", "preset", "sections", "visibility"]);
    expect(props("read_member")).toEqual(["fqn", "selectors"]);
    expect(props("read_source")).toEqual(["fqn", "from", "mode", "to"]);
    expect(props("read_resource")).toEqual(["artifact", "glob"]);
    expect(props("search_symbols")).toEqual(["artifact", "kind", "limit", "query"]);
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
    // provenance is a PROMISE that depends on JVM presence (source →
    // decompiled → signature), so it varies per machine like status's jvm
    // block: normalize every hit's provenance to a sentinel before the pin
    expectGolden(
      "find_class",
      normalizeFindClassProvenance(parsed),
    );
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

  it("preset param mirrors the CLI's --minimal exactly", async () => {
    const parsed = payload(await call("outline", { fqn: "com.example.Demo", preset: "minimal" }));
    const expected = await outline(c.ctx, "com.example.Demo", { preset: "minimal" });
    expect(parsed).toEqual(expected);
    expect(parsed.imports).toBeUndefined();
    expect(parsed.rows.some((r: any) => r.kind === "field")).toBe(false);
  });

  it("sections params mirror the CLI's toggles exactly", async () => {
    const parsed = payload(
      await call("outline", {
        fqn: "com.example.Demo",
        sections: { fields: false, javadoc: false },
      }),
    );
    const expected = await outline(c.ctx, "com.example.Demo", {
      sections: { fields: false, javadoc: false },
    });
    expect(parsed).toEqual(expected);
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

  it("no mode serves the full source by default", async () => {
    const parsed = payload(await call("read_source", { fqn: "com.example.Demo" }));
    expect(parsed.mode).toBe("full");
    expect(parsed.content).toContain("public Object run(String input, int count) throws Exception {");
  });

  it("explicit outline mode still returns the outline-shaped payload", async () => {
    const parsed = payload(await call("read_source", { fqn: "com.example.Demo", mode: "outline" }));
    const expected = await readSource(c.ctx, "com.example.Demo", { mode: "outline" });
    expect(parsed).toEqual(expected);
    expect(parsed.mode).toBe("outline");
    expect(Array.isArray(parsed.rows)).toBe(true);
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
      await call("read_resource", { artifact: "com.example:demo-lib-bin:1.0.0", glob: "config/*" }),
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

  it("search_symbols ranks the exact selector within the requested artifact", async () => {
    const parsed = payload(
      await call("search_symbols", { query: "run", artifact: "demo-lib", limit: 10 }),
    );
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows[0].selector).toBe("run");
  });

  it("where lists the artifact's recorded paths", async () => {
    const parsed = payload(await call("where", { coordinates: "com.example:demo-lib:1.0.0" }));
    expect(parsed.paths).toEqual([
      { role: "sourcesJar", path: DEMO_SOURCES_JAR, exists: true },
    ]);
    expect(existsSync(DEMO_SOURCES_JAR)).toBe(true);
  });
});

describe("status", () => {
  it("reports manifest and jvm, golden-pinned modulo volatile fields", async () => {
    const parsed = payload(await call("status", {}));
    expect(parsed.manifest.present).toBe(true);
    expect(parsed.index).toBeUndefined();
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
