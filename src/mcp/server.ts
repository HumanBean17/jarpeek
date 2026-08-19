/**
 * The MCP stdio server: the same query functions the CLI exposes, spoken as
 * MCP tools so a host agent can drive them in-process over JSON-RPC.
 *
 * Every handler serializes the exact object the CLI's `--json` prints — one
 * result shape, two transports. Misses stay protocol here too: a
 * `LookupMissError` (or a find-class that found nothing) walks `handleMiss`
 * and answers with its MissResult at `isError: false`; only core exceptions
 * become `isError: true` with `{error: message}`. Nothing may reach stdout
 * except the protocol itself, so banner/progress logs go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { handleMiss } from "../core/miss.js";
import { openContext, type QueryContext } from "../core/query/context.js";
import { findClass } from "../core/query/find-class.js";
import { LookupMissError, outline } from "../core/query/outline.js";
import { readMember } from "../core/query/read-member.js";
import { readResource } from "../core/query/read-resource.js";
import { readSource } from "../core/query/read-source.js";
import { resolveNow } from "../core/query/resolve-cmd.js";
import { searchSymbols } from "../core/query/search-symbols.js";
import { status } from "../core/query/status.js";
import { where } from "../core/query/where.js";
import { KIND_VALUES, VISIBILITY_VALUES } from "../core/enums.js";
import { VERSION } from "../version.js";

const KIND_ENUM = z.enum(KIND_VALUES);
const VISIBILITY_ENUM = z.enum(VISIBILITY_VALUES);

/** What one tool call answers with: the core result as a text block. */
type ToolPayload = CallToolResult;

function ok(result: unknown): ToolPayload {
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
}

function fail(error: unknown): ToolPayload {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Run one query under the shared miss policy: a `LookupMissError` walks the
 * miss protocol on the same context and answers with its result; anything
 * else is a tool error.
 */
async function run(ctx: QueryContext, body: () => Promise<ToolPayload>): Promise<ToolPayload> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof LookupMissError) {
      return ok(await handleMiss(ctx, error));
    }
    return fail(error);
  }
}

/** Read-eval-print for a find-class query, miss parity included. */
async function findClassTool(ctx: QueryContext, query: string, limit?: number): Promise<ToolPayload> {
  return run(ctx, async () => {
    const result = await findClass(ctx, query, limit !== undefined ? { limit } : {});
    if (result.hits.length === 0) {
      // the tiers already ran the suggestion ladder; only the negative remains
      return ok(await handleMiss(ctx, { query }));
    }
    return ok(result);
  });
}

/**
 * Register the 9 jarpeek tools on a fresh server. Schemas are 1:1 with the
 * CLI's arguments; `selectors` arrives as an array and joins with "," for the
 * core function, matching the CLI's comma-joined form.
 */
export function createMcpServer(ctx: QueryContext): McpServer {
  const server = new McpServer(
    { name: "jarpeek", version: VERSION },
    {
      instructions:
        "Context-frugal navigation into JVM dependency sources: find_class to locate, " +
        "outline to see members without source, then read_member/read_source for exactly " +
        "the slice needed — read_source serves the whole file by default, so prefer " +
        "outline and read_member first. Misses return suggestions, never errors.",
    },
  );

  server.registerTool(
    "find_class",
    {
      description: "Find classes by FQN, suffix, simple name, or fuzzy name.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    ({ query, limit }) => findClassTool(ctx, query, limit),
  );

  server.registerTool(
    "outline",
    {
      description:
        "Class skeleton data — declaration rows, imports, javadoc — with preset and per-section control mirroring the CLI.",
      inputSchema: {
        fqn: z.string(),
        kind: KIND_ENUM.optional(),
        visibility: VISIBILITY_ENUM.optional(),
        preset: z.enum(["minimal", "outline", "full"]).optional(),
        sections: z
          .object({
            imports: z.boolean().optional(),
            fields: z.boolean().optional(),
            methods: z.boolean().optional(),
            inner: z.boolean().optional(),
            javadoc: z.boolean().optional(),
          })
          .optional(),
      },
    },
    ({ fqn, kind, visibility, preset, sections }) =>
      run(ctx, async () =>
        ok(
          await outline(ctx, fqn, {
            ...(kind !== undefined ? { kind } : {}),
            ...(visibility !== undefined ? { visibility } : {}),
            ...(preset !== undefined ? { preset } : {}),
            ...(sections !== undefined ? { sections } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "read_member",
    {
      description: "Source slices for member selectors (#name, #name(T1,T2)).",
      inputSchema: { fqn: z.string(), selectors: z.array(z.string()).min(1) },
    },
    ({ fqn, selectors }) =>
      run(ctx, async () => ok(await readMember(ctx, fqn, selectors.join(",")))),
  );

  server.registerTool(
    "read_source",
    {
      description:
        "Source text for one class (full | lines | outline) — default full; prefer outline for the frugal first look.",
      inputSchema: {
        fqn: z.string(),
        mode: z.enum(["outline", "full", "lines"]).optional(),
        from: z.number().int().positive().optional(),
        to: z.number().int().positive().optional(),
      },
    },
    ({ fqn, mode, from, to }) =>
      run(ctx, async () =>
        ok(
          await readSource(ctx, fqn, {
            ...(mode !== undefined ? { mode } : {}),
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "read_resource",
    {
      description: "Non-class jar entries (config, services, manifests).",
      inputSchema: { artifact: z.string(), glob: z.string() },
    },
    ({ artifact, glob }) => run(ctx, async () => ok(await readResource(ctx, artifact, glob))),
  );

  server.registerTool(
    "search_symbols",
    {
      description:
        "Find declarations by member name in ONE artifact (g:a:v coordinates or unique artifact id).",
      inputSchema: {
        query: z.string(),
        artifact: z.string(),
        limit: z.number().int().positive().optional(),
        kind: KIND_ENUM.optional(),
      },
    },
    ({ query, artifact, limit, kind }) =>
      run(ctx, async () =>
        ok(
          await searchSymbols(ctx, query, {
            artifact,
            ...(limit !== undefined ? { limit } : {}),
            ...(kind !== undefined ? { kind } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "resolve",
    { description: "Re-resolve dependencies and rewrite the manifest.", inputSchema: {} },
    () => run(ctx, async () => ok(await resolveNow(ctx))),
  );

  server.registerTool("status", { description: "Manifest and JVM report.", inputSchema: {} }, () =>
    run(ctx, async () => ok(await status(ctx))),
  );

  server.registerTool(
    "where",
    { description: "On-disk paths for one artifact.", inputSchema: { coordinates: z.string() } },
    ({ coordinates }) => run(ctx, async () => ok(await where(ctx, coordinates))),
  );

  return server;
}

/**
 * Serve stdio forever. Bootstrap is lazy — the context resolves nothing
 * until the first tool call — and every diagnostic goes to stderr so the
 * stdout channel carries protocol frames only.
 */
export async function startMcpServer(projectRoot?: string): Promise<void> {
  const ctx = openContext(projectRoot ?? process.cwd(), {
    onNotice: (msg) => process.stderr.write(`[jarpeek] ${msg}...\n`),
  });
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[jarpeek] mcp server ready (project ${ctx.projectRoot})\n`);
  // the connected transport owns the event loop; this promise never settles
  await new Promise<never>(() => {});
}
