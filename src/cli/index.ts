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
 * stays parseable, under a hard three-line budget per invocation (one
 * bootstrap notice plus the two warning lines `warn` prints); the one
 * exception is bootstrap heartbeats, one line per 30s while a resolve is
 * actually running, so a minutes-long cold-cache download never reads as a
 * hang.
 */
import { Command, InvalidArgumentError } from "commander";
import { VERSION } from "../version.js";
import { renderJson } from "./json.js";
import { clipCell, numberLines, renderTable } from "./render.js";
import { handleMiss, type MissResult } from "../core/miss.js";
import { openContext, type QueryContext } from "../core/query/context.js";
import { findClass, type FindClassResult } from "../core/query/find-class.js";
import {
  LookupMissError,
  outline,
  resolveSections,
  type OutlinePreset,
  type Sections,
} from "../core/query/outline.js";
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
import { renderSkeleton } from "./skeleton.js";

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

/** Context with the bootstrap's one notice line routed to stderr. */
function ctxFor(inv: Invocation): QueryContext {
  return openContext(inv.project, {
    onNotice: (msg) => process.stderr.write(`[jarpeek] ${msg}...\n`),
  });
}

/**
 * Print warnings to stderr under the output budget: the first warning
 * verbatim, everything after it collapsed into ONE aggregate line pointing
 * at `jarpeek status`. Deduplicated (order-preserving) before counting, so
 * the same degradation named twice costs nothing. Together with the single
 * bootstrap notice this keeps any invocation at ≤3 stderr lines — the number
 * is the product feature (v1 printed one line per artifact). Bootstrap
 * heartbeats are the sanctioned exception: one line per 30s while a resolve
 * runs, never more.
 */
function warn(...messages: string[]): void {
  const unique = [...new Set(messages)];
  if (unique.length === 0) return;
  process.stderr.write(`warning: ${unique[0]}\n`);
  if (unique.length > 1) {
    process.stderr.write(`warning: +${unique.length - 1} more (see: jarpeek status)\n`);
  }
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
  const searched = miss.searchedArtifacts.length > 0 ? miss.searchedArtifacts.join("\n  ") : "(none)";
  process.stdout.write(`${label} ${miss.note}\nsearched:\n  ${searched}\n`);
  // a miss born of a failed resolve carries the reason (spec decision #1):
  // the negative's degraded set warns through the same budgeted channel the
  // hits path uses, so "(none)" searched never reads as "nothing to resolve"
  if (miss.degraded.length > 0) warn(...miss.degraded);
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
    // unreachable from CLI flags (no flag selects outline mode) — kept so a
    // future flag and the MCP surface render the same skeleton, never a table
    return [
      renderSkeleton(result, resolveSections("outline", undefined), "summary"),
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

/** Warnings a human `resolve` prints before collapsing the rest into one line. */
const RESOLVE_WARNING_LINES = 5;

function renderResolve(result: ResolveNowResult): string {
  const warnings = result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : "";
  // the cap is presentation-only: --json prints the full array, a human gets
  // the first few and a pointer — a cache-scan resolve can carry one warning
  // per ambiguous g:a, and v1's line-spew must not come back through stdout
  const shown = result.warnings.slice(0, RESOLVE_WARNING_LINES);
  const rest = result.warnings.length - shown.length;
  return [
    `resolved ${result.artifactCount} artifacts in ${result.durationMs}ms${warnings}`,
    ...shown,
    ...(rest > 0 ? [`+${rest} more (see: jarpeek status)`] : []),
  ].join("\n");
}

function renderStatus(result: StatusResult): string {
  return renderTable([
    ["KEY", "VALUE"],
    ["projectRoot", result.projectRoot],
    ["manifest.present", String(result.manifest.present)],
    ["manifest.resolvedAt", result.manifest.resolvedAt ?? ""],
    ["manifest.stale", String(result.manifest.stale)],
    ["manifest.artifactCount", String(result.manifest.artifactCount)],
    ["manifest.dependencySetHash", result.manifest.dependencySetHash ?? ""],
    ["jvm.available", String(result.jvm.available)],
    ["jvm.version", result.jvm.version ?? ""],
  ]);
}

function renderWhere(result: WhereResult): string {
  // one line per path, not a table: the paths are the payload and must never
  // be clipped by the 60-char column cap
  return [
    `coordinates ${result.coordinates}`,
    ...result.paths.map((row) => `${row.role} ${row.path} (${row.exists ? "exists" : "missing"})`),
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

/** Flags of the outline subcommand: presets, section toggles, legacy table. */
interface OutlineCmd {
  kind?: string;
  visibility?: string;
  minimal?: boolean;
  full?: boolean;
  imports?: boolean;
  fields?: boolean;
  methods?: boolean;
  inner?: boolean;
  javadoc?: boolean;
  table?: boolean;
}

command(
  "outline",
  "java-shaped class skeleton (presets + section toggles; --table for the legacy view)",
)
  .argument("<fqn>")
  .option("--kind <k>", "filter by declaration kind")
  .option("--visibility <v>", "filter by visibility")
  .option("--minimal", "preset: no imports, no fields, no javadoc")
  .option("--full", "preset: everything, javadoc blocks and body markers")
  .option("--imports", "show imports (overrides the preset)")
  .option("--no-imports", "hide imports (overrides the preset)")
  .option("--fields", "show fields/properties/enum constants (overrides the preset)")
  .option("--no-fields", "hide fields/properties/enum constants (overrides the preset)")
  .option("--methods", "show methods/constructors (overrides the preset)")
  .option("--no-methods", "hide methods/constructors (overrides the preset)")
  .option("--inner", "show nested classes (overrides the preset)")
  .option("--no-inner", "hide nested classes (overrides the preset)")
  .option("--javadoc", "show javadoc (overrides the preset)")
  .option("--no-javadoc", "hide javadoc (overrides the preset)")
  .option("--table", "the legacy tabular view over the same rows")
  .action(async (fqn: string, cmd: OutlineCmd) => {
    if (cmd.minimal && cmd.full) {
      throw new InvalidArgumentError("--minimal and --full are mutually exclusive");
    }
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const preset: OutlinePreset = cmd.minimal ? "minimal" : cmd.full ? "full" : "outline";
      // each declared toggle overrides its preset section; commander leaves
      // absent flags undefined, so only spelled-out pairs land here
      const toggles: Partial<Sections> = {
        ...(cmd.imports !== undefined ? { imports: cmd.imports } : {}),
        ...(cmd.fields !== undefined ? { fields: cmd.fields } : {}),
        ...(cmd.methods !== undefined ? { methods: cmd.methods } : {}),
        ...(cmd.inner !== undefined ? { inner: cmd.inner } : {}),
        ...(cmd.javadoc !== undefined ? { javadoc: cmd.javadoc } : {}),
      };
      const hasToggles = Object.values(toggles).length > 0;
      const result = await outline(ctx, fqn, {
        ...(cmd.kind !== undefined ? { kind: cmd.kind as DeclKind } : {}),
        ...(cmd.visibility !== undefined ? { visibility: cmd.visibility as Visibility } : {}),
        preset,
        ...(hasToggles ? { sections: toggles } : {}),
      });
      emit(result, inv, () => {
        if (cmd.table) {
          return [
            `${result.fqn}  ${result.coordinates}  provenance ${result.provenance}`,
            renderOutlineRows(result.rows),
            ...(result.alternatives?.map((alt) => `alternative: ${alt.coordinates}`) ?? []),
          ].join("\n");
        }
        // the skeleton: same rows, code-shaped — full adds javadoc blocks
        // and body markers over the identical section booleans
        return [
          renderSkeleton(result, resolveSections(preset, hasToggles ? toggles : undefined), preset === "full" ? "full" : "summary"),
          ...(result.alternatives?.map((alt) => `alternative: ${alt.coordinates}`) ?? []),
        ].join("\n");
      });
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
      // one warn call for the whole invocation: the budget is per run, not
      // per warn site, so misses and degradations share the two-line ceiling
      warn(
        ...result.misses.map((miss) => `${miss.selector}: ${miss.reason}`),
        ...result.degraded,
      );
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

command("search-symbols", "find declarations by member name in one artifact")
  .argument("<query>")
  .requiredOption("--artifact <coords>", "g:a:v coordinates or unique artifact id")
  .option("--limit <n>", "max rows", parsePositiveInt, 50)
  .option("--kind <k>", "filter by declaration kind")
  .action(async (query: string, cmd: { artifact: string; limit: number; kind?: string }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await searchSymbols(ctx, query, {
        artifact: cmd.artifact,
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

command("resolve", "force a dependency resolve pass").action(async () => {
  const inv = invocation();
  const ctx = ctxFor(inv);
  const result = await resolveNow(ctx);
  emit(result, inv, () => renderResolve(result));
  warn(...result.degraded.map((entry) => `${entry.from}: ${entry.reason}`));
});

command("status", "manifest and JVM report").action(async () => {
  const inv = invocation();
  const result = await status(ctxFor(inv));
  emit(result, inv, () => renderStatus(result));
  if (result.degraded.length > 0) warn(...result.degraded);
});

command("where", "on-disk paths for one artifact")
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
  .option("--yes", "non-interactive: claude + mcp defaults")
  .action(async (cmd: { yes?: boolean }) => {
    const inv = invocation();
    const result = await runInit(inv.project, { yes: cmd.yes === true });
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
