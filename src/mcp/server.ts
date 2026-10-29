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
import { RootsListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { handleMiss } from "../core/miss.js";
import type { OpenContextOptions, QueryContext } from "../core/query/context.js";
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
import { Workspace } from "../workspace/workspace.js";

const KIND_ENUM = z.enum(KIND_VALUES);
/** The optional build scope every tool accepts. */
const PROJECT = z
  .string()
  .optional()
  .describe(
    "Multi-build workspaces: the build to query — a path inside it, or its workspace-relative path (as listed by status). Default: every build.",
  );

/**
 * Where a tool call gets its context: a fixed context (single project,
 * tests), or a resolver from the call's `project` argument (the workspace).
 */
export type ContextSource = QueryContext | ((project?: string) => Promise<QueryContext> | QueryContext);
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
async function run(
  source: ContextSource,
  project: string | undefined,
  body: (ctx: QueryContext) => Promise<ToolPayload>,
): Promise<ToolPayload> {
  let ctx: QueryContext;
  try {
    ctx = typeof source === "function" ? await source(project) : source;
  } catch (error) {
    // an unknown `project` is a usage error naming the builds that exist
    return fail(error);
  }
  try {
    return await body(ctx);
  } catch (error) {
    if (error instanceof LookupMissError) {
      return ok(await handleMiss(ctx, error));
    }
    return fail(error);
  }
}

/** Read-eval-print for a find-class query, miss parity included. */
async function findClassTool(
  source: ContextSource,
  project: string | undefined,
  query: string,
  limit?: number,
): Promise<ToolPayload> {
  return run(source, project, async (ctx) => {
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
export function createMcpServer(source: ContextSource): McpServer {
  const server = new McpServer(
    { name: "jarpeek", version: VERSION },
    {
      instructions:
        "Context-frugal navigation into JVM dependency sources: find_class to locate, " +
        "outline to see members without source, then read_member/read_source for exactly " +
        "the slice needed — read_source serves the whole file by default, so prefer " +
        "outline and read_member first. Misses return suggestions, never errors. In a workspace " +
        "with several Gradle/Maven builds, queries span all of them and hits name their `projects`; " +
        "pass `project` to scope a call to one build.",
    },
  );

  server.registerTool(
    "find_class",
    {
      description: "Find classes by FQN, suffix, simple name, or fuzzy name.",
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional(), project: PROJECT },
    },
    ({ query, limit, project }) => findClassTool(source, project, query, limit),
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
        project: PROJECT,
      },
    },
    ({ fqn, kind, visibility, preset, sections, project }) =>
      run(source, project, async (ctx) =>
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
      inputSchema: { fqn: z.string(), selectors: z.array(z.string()).min(1), project: PROJECT },
    },
    ({ fqn, selectors, project }) =>
      run(source, project, async (ctx) => ok(await readMember(ctx, fqn, selectors.join(",")))),
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
        project: PROJECT,
      },
    },
    ({ fqn, mode, from, to, project }) =>
      run(source, project, async (ctx) =>
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
      inputSchema: { artifact: z.string(), glob: z.string(), project: PROJECT },
    },
    ({ artifact, glob, project }) =>
      run(source, project, async (ctx) => ok(await readResource(ctx, artifact, glob))),
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
        project: PROJECT,
      },
    },
    ({ query, artifact, limit, kind, project }) =>
      run(source, project, async (ctx) =>
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
    {
      description:
        "Re-resolve dependencies and rewrite the manifest. forceUpdate (Maven -U / Gradle --refresh-dependencies) clears cached negative lookups — the healing path when status reports manifest.incomplete.",
      inputSchema: { forceUpdate: z.boolean().optional(), project: PROJECT },
    },
    ({ forceUpdate, project }) =>
      run(source, project, async (ctx) =>
        ok(await resolveNow(ctx, ...(forceUpdate !== undefined ? [{ forceUpdate }] : []))),
      ),
  );

  server.registerTool(
    "status",
    {
      description: "Manifest and JVM report; in a multi-build workspace, one entry per build under `projects`.",
      inputSchema: { project: PROJECT },
    },
    ({ project }) => run(source, project, async (ctx) => ok(await status(ctx))),
  );

  server.registerTool(
    "where",
    { description: "On-disk paths for one artifact.", inputSchema: { coordinates: z.string(), project: PROJECT } },
    ({ coordinates, project }) => run(source, project, async (ctx) => ok(await where(ctx, coordinates))),
  );

  return server;
}

/** How long the server waits for the client's roots before falling back to its cwd. */
const ROOTS_TIMEOUT_MS = 5_000;

/** The client's file:// roots as directories, or null when it offers none. */
async function clientRoots(server: McpServer): Promise<string[] | null> {
  if (server.server.getClientCapabilities()?.roots === undefined) return null;
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
    const dirs = roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
    return dirs.length > 0 ? dirs : null;
  } catch {
    return null;
  }
}

export interface WorkspaceServerOptions {
  /** `--project`: pins the workspace, ignoring client roots. */
  project?: string;
  /** Options every build's context opens with (notice sink, build-tool flag, test resolvers). */
  context?: OpenContextOptions;
}

/**
 * The server over a lazily-discovered workspace: `project` when given,
 * else the client's MCP roots (the session folder: a repo root, a
 * worktree, a monorepo), else the cwd — rediscovered when the client's
 * roots change. Nothing is discovered or resolved before the first call.
 */
export function createWorkspaceServer(opts: WorkspaceServerOptions = {}): McpServer {
  let workspace: Promise<Workspace> | undefined;
  const current = (): Promise<Workspace> =>
    (workspace ??= (async () => {
      const dirs = opts.project !== undefined ? [opts.project] : ((await clientRoots(server)) ?? [process.cwd()]);
      return new Workspace(dirs, opts.context);
    })());
  const server = createMcpServer(async (project) => (await current()).context(project));
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    if (opts.project === undefined) workspace = undefined;
  });
  return server;
}

/** Serve stdio forever; every diagnostic goes to stderr so stdout carries protocol frames only. */
export async function startMcpServer(projectFlag?: string, buildToolFlag?: string): Promise<void> {
  const server = createWorkspaceServer({
    project: projectFlag,
    context: { onNotice: (msg) => process.stderr.write(`[jarpeek] ${msg}...\n`), buildToolFlag },
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[jarpeek] mcp server ready (workspace: ${projectFlag ?? `client roots, else ${process.cwd()}`})\n`,
  );
  // the connected transport owns the event loop; this promise never settles
  await new Promise<never>(() => {});
}
