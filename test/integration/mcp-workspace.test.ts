/**
 * The machine-wide MCP server over a real SDK client: the workspace is the
 * client's MCP root (Claude Code sends the session folder), a monorepo root
 * spans every build, `project` scopes a call, and a roots change
 * rediscovers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createWorkspaceServer } from "../../src/mcp/server.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";

const DEMO_SOURCES_JAR = resolve(__dirname, "..", "fixtures", "jars", "demo-lib-1.0.0-sources.jar");

const cleanup: Array<() => unknown> = [];

beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "jarpeek-mcpws-cache-"));
  process.env.JARPEEK_CACHE_DIR = cache;
  cleanup.push(() => rmSync(cache, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function monorepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jarpeek-mcpws-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "svc", "a"), { recursive: true });
  mkdirSync(join(root, "svc", "b"), { recursive: true });
  writeFileSync(join(root, "svc", "a", "pom.xml"), `<project/><!-- ${root} -->`);
  writeFileSync(join(root, "svc", "b", "pom.xml"), `<project/><!-- b ${root} -->`);
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

/** Every Maven build reports demo-lib at a version derived from its directory name. */
const resolvers: ResolveDependenciesOptions = {
  includeJdk: false,
  maven: async (projectRoot) => ({
    ok: true,
    artifacts: [
      {
        coordinates: `com.example:demo-lib:${projectRoot.endsWith("a") ? "1.0.0" : "2.0.0"}`,
        kind: "external",
        sourcesJar: DEMO_SOURCES_JAR,
      },
    ],
  }),
  cacheScan: async () => ({ artifacts: [], warnings: [] }),
};

/** A client exposing `roots` (mutable) over a linked in-memory transport. */
async function connect(roots: { dirs: string[] }): Promise<Client> {
  const server = createWorkspaceServer({ context: { resolvers } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "roots-client", version: "0.0.0" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: roots.dirs.map((dir) => ({ uri: pathToFileURL(dir).href })),
  }));
  await client.connect(clientTransport);
  cleanup.push(() => server.close(), () => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: any }> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) };
}

describe("workspace MCP server", () => {
  it("a monorepo root (the client's MCP root) spans every build, hits labeled", async () => {
    const root = monorepo();
    const client = await connect({ dirs: [root] });
    const { body } = await call(client, "find_class", { query: "com.example.Demo" });
    expect(body.hits.map((h: any) => [h.coordinates, h.projects])).toEqual([
      ["com.example:demo-lib:1.0.0", ["svc/a"]],
      ["com.example:demo-lib:2.0.0", ["svc/b"]],
    ]);
    const report = await call(client, "status", {});
    expect(report.body.projects.map((p: any) => p.project)).toEqual(["svc/a", "svc/b"]);
  });

  it("`project` scopes a call; an unknown one is a tool error naming the builds", async () => {
    const root = monorepo();
    const client = await connect({ dirs: [root] });
    const scoped = await call(client, "outline", { fqn: "com.example.Demo", project: "svc/b" });
    expect(scoped.body.coordinates).toBe("com.example:demo-lib:2.0.0");

    const bad = await call(client, "outline", { fqn: "com.example.Demo", project: "svc/zzz" });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toContain("builds in this workspace: svc/a, svc/b");
  });

  it("a roots change rediscovers the workspace", async () => {
    const root = monorepo();
    const roots = { dirs: [join(root, "svc", "a")] };
    const client = await connect(roots);
    expect((await call(client, "status", {})).body.projectRoot).toBe(join(root, "svc", "a"));

    roots.dirs = [join(root, "svc", "b")];
    await client.sendRootsListChanged();
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(client, "status", {})).body.projectRoot).toBe(join(root, "svc", "b"));
  });
});
