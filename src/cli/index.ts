#!/usr/bin/env node
/**
 * The jarpeek CLI: every core query function as a dash-named subcommand.
 *
 * Two output modes over one result object: `--json` prints the core result
 * verbatim (the same object the MCP tool returns — Task 20's parity
 * contract), the default prints human tables/text via render.ts. Misses are
 * protocol, not errors: a LookupMissError (or a find-class that found
 * nothing) walks handleMiss and exits 0 with its answer; SelectorError and
 * IO failures are the only fatal paths (exit 1). Everything diagnostic —
 * bootstrap progress, warnings, degradations — goes to stderr so stdout
 * stays parseable.
 */
import { Command, InvalidArgumentError } from "commander";
import { VERSION } from "../version.js";
import { renderJson } from "./json.js";
import { clipCell, numberLines, renderTable } from "./render.js";
import { handleMiss, type MissResult } from "../core/miss.js";
import { openContext, type QueryContext } from "../core/query/context.js";
import { findClass, type FindClassResult } from "../core/query/find-class.js";
import { LookupMissError, outline } from "../core/query/outline.js";
import { readMember, type MemberSlice, type ReadMemberResult } from "../core/query/read-member.js";
import { readResource, type ReadResourceResult } from "../core/query/read-resource.js";
import { readSource, type ReadSourceResult } from "../core/query/read-source.js";
import { resolveNow, type ResolveNowResult } from "../core/query/resolve-cmd.js";
import { searchSymbols, type SymbolResult } from "../core/query/search-symbols.js";
import { status, type StatusResult } from "../core/query/status.js";
import { where, type WhereResult } from "../core/query/where.js";
import { SelectorError } from "../core/selector.js";
import type { Declaration, DeclKind, Visibility } from "../core/types.js";
import { runInit, type InitResult } from "../harness/init.js";
import { registerMcpCommand } from "./mcp-command.js";
import { prime, type PrimeOptions } from "../prime/command.js";

/** Per-invocation flags of the prime subcommand. */
interface PrimeFlags extends PrimeOptions {
  export?: boolean;
}

/** Fatal exit code: bad args, malformed selectors, IO failures. */
const EXIT_FATAL = 1;

/** Options shared by every subcommand (declared on the program, inherited). */
interface GlobalOptions {
  json?: boolean;
  project?: string;
}

/** Per-invocation view of the global options. */
interface Invocation {
  json: boolean;
  project: string;
}

/** Context with bootstrap progress lines routed to stderr. */
function ctxFor(inv: Invocation): QueryContext {
  return openContext(inv.project, {
    onProgress: (msg) => process.stderr.write(`[jarpeek] ${msg}\n`),
  });
}

/** Print `warning: <msg>` lines (degradations, partial misses) to stderr. */
function warn(...messages: string[]): void {
  for (const message of messages) process.stderr.write(`warning: ${message}\n`);
}

/** Emit the result object in the mode the invocation asked for. */
function emit(result: unknown, inv: Invocation, render: () => string): void {
  process.stdout.write(inv.json ? `${renderJson(result)}\n` : `${render()}\n`);
}

/**
 * Print a miss-protocol answer to stdout. Misses are definitive answers, not
 * errors — the process exits 0 after this.
 */
function emitMiss(miss: MissResult, label: string, inv: Invocation): void {
  if (inv.json) {
    process.stdout.write(`${renderJson(miss)}\n`);
    return;
  }
  if (miss.found && miss.via === "fuzzy-candidates") {
    process.stdout.write(
      `no indexed class for ${label}; did you mean:\n${renderFindClassRows(miss.hits)}\n`,
    );
    return;
  }
  if (miss.found) {
    process.stdout.write(
      `found ${label} in ${miss.coordinates} via ${miss.via} (provenance ${miss.provenance})\n`,
    );
    return;
  }
  const searched = miss.searchedArtifacts.length > 0 ? miss.searchedArtifacts.join("\n  ") : "(none)";
  process.stdout.write(`${label} ${miss.note}\nsearched:\n  ${searched}\n`);
}

/**
 * Run one command body under the shared miss policy: a LookupMissError walks
 * the miss protocol on the same context and prints its answer; anything else
 * propagates to the fatal handler.
 */
async function runQuery(
  inv: Invocation,
  ctx: QueryContext,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof LookupMissError) {
      emitMiss(await handleMiss(ctx, error), error.fqn, inv);
      return;
    }
    throw error;
  }
}

// -- human renderers ----------------------------------------------------------

function renderFindClassRows(hits: FindClassResult["hits"]): string {
  return renderTable([
    ["FQN", "KIND", "ARTIFACT", "PROVENANCE"],
    ...hits.map((hit) => [hit.fqn, hit.kind, hit.coordinates, hit.provenance]),
  ]);
}

function renderOutlineRows(rows: Declaration[]): string {
  return renderTable([
    ["SELECTOR", "KIND", "VIS", "STATIC", "DEP", "SIGNATURE"],
    ...rows.map((row) => [
      clipCell(row.selector),
      row.kind,
      row.visibility,
      row.static ? "static" : "",
      row.deprecated ? "dep" : "",
      clipCell(row.signature),
    ]),
  ]);
}

function renderMember(member: MemberSlice, fqn: string, provenance: string): string {
  const numbered = member.startLine > 0 ? numberLines(member.lines, member.startLine) : member.lines;
  const span =
    member.startLine > 0
      ? `lines ${member.startLine}–${member.endLine}`
      : "signature only";
  return [`${fqn}#${member.selector}  (${span}  provenance ${provenance})`, ...numbered].join("\n");
}

function renderReadMember(result: ReadMemberResult): string {
  const blocks = result.members.map((member) => renderMember(member, result.fqn, result.provenance));
  return [
    ...blocks,
    ...result.misses.map((miss) => `miss ${miss.selector}: ${miss.reason}`),
    ...(result.alternatives?.map((alt) => `alternative: ${alt.coordinates}`) ?? []),
  ].join("\n\n");
}

function renderReadSource(result: ReadSourceResult): string {
  if (result.mode === "outline") {
    return [
      `${result.fqn}  ${result.coordinates}  provenance ${result.provenance}`,
      renderOutlineRows(result.rows),
      ...(result.alternatives?.map((alt) => `alternative: ${alt.coordinates}`) ?? []),
    ].join("\n");
  }
  const header = `file ${result.file} provenance ${result.provenance}`;
  if (result.mode === "full") {
    return [`${header} lines 1-${result.lineCount}`, ...numberLines(result.content.split("\n"), 1)].join("\n");
  }
  const clamp = result.clamped ? " (clamped)" : "";
  return [
    `${header} lines ${result.startLine}-${result.endLine} of ${result.lineCount}${clamp}`,
    ...numberLines(result.lines, result.startLine),
  ].join("\n");
}

function renderReadResource(result: ReadResourceResult): string {
  if (result.entries.length === 0) {
    return `artifact ${result.artifact}: no matching entries (provenance ${result.provenance})`;
  }
  return [
    `artifact ${result.artifact} provenance ${result.provenance}`,
    renderTable([
      ["PATH", "SIZE", "CONTENT"],
      ...result.entries.map((entry) => [
        clipCell(entry.path),
        entry.size !== undefined ? String(entry.size) : "",
        clipCell(entry.content ?? entry.note ?? ""),
      ]),
    ]),
  ].join("\n");
}

function renderSearchSymbols(result: SymbolResult): string {
  return renderTable([
    ["SELECTOR", "FQN", "KIND", "ARTIFACT", "PROV", "SIGNATURE"],
    ...result.rows.map((row) => [
      clipCell(row.selector),
      clipCell(row.fqn),
      row.kind,
      row.coordinates,
      row.provenance,
      clipCell(row.signature),
    ]),
  ]);
}

function renderResolve(result: ResolveNowResult): string {
  return [
    renderTable([
      ["STATUS", "COORDINATES", "REASON"],
      ...result.indexed.map((coordinates): string[] => ["indexed", coordinates, ""]),
      ...result.skipped.map((skip): string[] => ["skipped", skip.coordinates, clipCell(skip.reason)]),
    ]),
    `resolve: indexed ${result.indexed.length}, skipped ${result.skipped.length} in ${result.durationMs}ms`,
  ].join("\n");
}

function renderStatus(result: StatusResult): string {
  return renderTable([
    ["KEY", "VALUE"],
    ["projectRoot", result.projectRoot],
    ["cacheDir", result.cacheDir],
    ["manifest.present", String(result.manifest.present)],
    ["manifest.resolvedAt", result.manifest.resolvedAt ?? ""],
    ["manifest.stale", String(result.manifest.stale)],
    ["manifest.artifactCount", String(result.manifest.artifactCount)],
    ["manifest.dependencySetHash", result.manifest.dependencySetHash ?? ""],
    ["index.artifactCount", String(result.index.artifactCount)],
    ["index.fqnCount", String(result.index.fqnCount)],
    ["jvm.available", String(result.jvm.available)],
    ["jvm.version", result.jvm.version ?? ""],
  ]);
}

function renderWhere(result: WhereResult): string {
  // key-value lines, not a table: the dir is the payload and must never be
  // clipped by the 60-char column cap
  return [
    `coordinates ${result.coordinates}`,
    `dir ${result.dir}`,
    `files ${result.fileCount}`,
    ...(result.note !== undefined ? [`note ${result.note}`] : []),
  ].join("\n");
}

// -- flag parsing --------------------------------------------------------------

/** `a:b` → {from, to}; non-numeric, 0-based, or inverted ranges are usage errors. */
function parseLinesFlag(value: string): { from: number; to: number } {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (match === null) {
    throw new InvalidArgumentError(`--lines expects from:to (e.g. 2:3), got "${value}"`);
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from < 1 || to < from) {
    throw new InvalidArgumentError(`--lines expects 1-based from:to with to >= from, got "${value}"`);
  }
  return { from, to };
}

/**
 * `--limit` value → positive integer. A NaN limit (e.g. `--limit abc`)
 * silently emptied every result set; a non-positive one was meaningless —
 * both are usage errors now, not quiet zeros.
 */
function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return n;
}

function renderInit(result: InitResult): string {
  return [
    `build systems: ${result.detected.buildSystems.join(", ") || "(none)"}`,
    `jdk: ${result.detected.jdk ?? "(not detected)"}`,
    ...result.wired.map(
      (entry) => `wired ${entry.harness} (${entry.mode}): ${entry.targets.join(", ")}`,
    ),
    `indexed: ${result.indexed ? "yes" : "no"}`,
    ...result.notes.map((note) => `note: ${note}`),
  ].join("\n");
}

// -- command surface -------------------------------------------------------------

const program = new Command();

program
  .name("jarpeek")
  .description("Dependency source access for AI agents on JVM projects")
  .version(VERSION)
  .option("--json", "machine-readable output (the exact MCP result object)")
  .option("--project <dir>", "project root (default: cwd)");

/** Declare a subcommand. Global flags are program-level and sticky. */
function command(name: string, description: string) {
  const sub = program.command(name);
  sub.description(description);
  return sub;
}

/**
 * Global options for the running invocation. Commander 12's sticky globals
 * land on `program.opts()` in both leading (`jarpeek --json find-class X`)
 * and trailing (`jarpeek find-class X --json`) positions; per-command flags
 * stay on the subcommand's own opts object.
 */
function invocation(): Invocation {
  const opts = program.opts<GlobalOptions>();
  return { json: opts.json === true, project: opts.project ?? process.cwd() };
}

command("find-class", "find classes by FQN, suffix, simple name, or fuzzy name")
  .argument("<query>")
  .option("--limit <n>", "max hits", parsePositiveInt, 20)
  .action(async (query: string, cmd: { limit: number }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await findClass(ctx, query, { limit: cmd.limit });
      if (result.hits.length === 0) {
        // the tiers already ran the suggestion ladder; only the negative remains
        emitMiss(await handleMiss(ctx, { query }), query, inv);
        return;
      }
      emit(result, inv, () => renderFindClassRows(result.hits));
      if (result.degraded.length > 0) warn(...result.degraded);
    });
  });

command("outline", "declaration rows for one class")
  .argument("<fqn>")
  .option("--kind <k>", "filter by declaration kind")
  .option("--visibility <v>", "filter by visibility")
  .action(async (fqn: string, cmd: { kind?: string; visibility?: string }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await outline(ctx, fqn, {
        ...(cmd.kind !== undefined ? { kind: cmd.kind as DeclKind } : {}),
        ...(cmd.visibility !== undefined ? { visibility: cmd.visibility as Visibility } : {}),
      });
      emit(result, inv, () =>
        [
          `${result.fqn}  ${result.coordinates}  provenance ${result.provenance}`,
          renderOutlineRows(result.rows),
          ...(result.alternatives?.map((alt) => `alternative: ${alt.coordinates}`) ?? []),
        ].join("\n"),
      );
      if (result.degraded.length > 0) warn(...result.degraded);
    });
  });

command("read-member", "source slices for member selectors (#name, #name(T1,T2))")
  .argument("<fqn>")
  .argument("<selectors...>")
  .action(async (fqn: string, selectors: string[]) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      // space-separated args and one comma-joined string are the same list
      const result = await readMember(ctx, fqn, selectors.join(","));
      emit(result, inv, () => renderReadMember(result));
      for (const miss of result.misses) warn(`${miss.selector}: ${miss.reason}`);
      if (result.degraded.length > 0) warn(...result.degraded);
    });
  });

command("read-source", "source text for one class (outline | full | lines)")
  .argument("<fqn>")
  .option("--full", "the whole file")
  .option("--lines <a:b>", "line range, e.g. 2:3")
  .action(async (fqn: string, cmd: { full?: boolean; lines?: string }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      if (cmd.full && cmd.lines !== undefined) {
        throw new InvalidArgumentError("--full and --lines are mutually exclusive");
      }
      const result = cmd.full
        ? await readSource(ctx, fqn, { mode: "full" })
        : cmd.lines !== undefined
          ? await readSource(ctx, fqn, { mode: "lines", ...parseLinesFlag(cmd.lines) })
          : await readSource(ctx, fqn);
      emit(result, inv, () => renderReadSource(result));
      if (result.degraded.length > 0) warn(...result.degraded);
    });
  });

command("read-resource", "non-class jar entries (config, services, manifests)")
  .argument("<artifact>")
  .argument("<glob>")
  .action(async (artifact: string, glob: string) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await readResource(ctx, artifact, glob);
      emit(result, inv, () => renderReadResource(result));
    });
  });

command("search-symbols", "find declarations by member name across artifacts")
  .argument("<query>")
  .option("--limit <n>", "max rows", parsePositiveInt, 50)
  .option("--kind <k>", "filter by declaration kind")
  .action(async (query: string, cmd: { limit: number; kind?: string }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await searchSymbols(ctx, query, {
        limit: cmd.limit,
        ...(cmd.kind !== undefined ? { kind: cmd.kind as DeclKind } : {}),
      });
      emit(
        result,
        inv,
        () => (result.rows.length > 0 ? renderSearchSymbols(result) : `no symbols found for ${query}`),
      );
      if (result.degraded.length > 0) warn(...result.degraded);
    });
  });

command("resolve", "force a resolve + index pass").action(async () => {
  const inv = invocation();
  const ctx = ctxFor(inv);
  const result = await resolveNow(ctx, {
    onProgress: (msg) => process.stderr.write(`[jarpeek] ${msg}\n`),
  });
  emit(result, inv, () => renderResolve(result));
  if (result.warnings.length > 0) warn(...result.warnings);
  for (const entry of result.degraded) warn(`${entry.from}: ${entry.reason}`);
});

command("status", "manifest, index, and JVM report").action(async () => {
  const inv = invocation();
  const result = await status(ctxFor(inv));
  emit(result, inv, () => renderStatus(result));
  if (result.degraded.length > 0) warn(...result.degraded);
});

command("where", "on-disk sources for one artifact")
  .argument("<coordinates>")
  .action(async (coordinates: string) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await where(ctx, coordinates);
      emit(result, inv, () => renderWhere(result));
    });
  });

registerMcpCommand(program);

command("prime", "the jarpeek cheatsheet for agents (this file)")
  .option("--full", "the full cli cheatsheet (default without MCP wiring)")
  .option("--mcp", "the short mcp card")
  .option("--export", "the default content even when .jarpeek/PRIME.md exists")
  .option("--hook-json", "wrap the text as a SessionStart hook additionalContext payload")
  .action(async (cmd: PrimeFlags) => {
    const inv = invocation();
    const result = prime(inv.project, {
      full: cmd.full === true,
      mcp: cmd.mcp === true,
      exportContent: cmd.export === true,
      hookJson: cmd.hookJson === true,
    });
    // both cheatsheets (and a user override) may end in newlines; one terminator
    process.stdout.write(
      inv.json ? `${renderJson(result)}\n` : `${result.text.replace(/\n+$/, "")}\n`,
    );
  });

command("init", "wire AI harnesses (MCP server or CLI hints) for this project")
  .option("--yes", "non-interactive: claude + mcp defaults, skip the first index")
  .action(async (cmd: { yes?: boolean }) => {
    const inv = invocation();
    const result = await runInit(inv.project, {
      yes: cmd.yes === true,
      onProgress: (msg) => process.stderr.write(`[jarpeek] ${msg}\n`),
    });
    emit(result, inv, () => renderInit(result));
  });

program.action(() => {
  program.help();
});

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    error instanceof SelectorError || error instanceof InvalidArgumentError
      ? `${message}\n`
      : `error: ${message}\n`,
  );
  process.exit(EXIT_FATAL);
});
