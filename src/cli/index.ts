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
import { Command, InvalidArgumentError, Option } from "commander";
import { KIND_VALUES, VISIBILITY_VALUES } from "../core/enums.js";
import { VERSION } from "../version.js";
import { renderJson } from "./json.js";
import { clipCell, numberLines, renderTable, renderStatus } from "./render.js";
import { handleMiss, type MissResult } from "../core/miss.js";
import { fuzzyScore } from "../core/fuzzy.js";
import { openContext, type QueryContext } from "../core/query/context.js";
import { BUILD_TOOL_STRATEGIES } from "../resolver/strategy.js";
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
import {
  findClassHelp,
  initHelp,
  outlineHelp,
  primeHelp,
  readMemberHelp,
  readResourceHelp,
  readSourceHelp,
  resolveHelp,
  searchSymbolsHelp,
  statusHelp,
  topLevelHelp,
  whereHelp,
} from "./help.js";
import { catalog, LOCALE_VALUES, preScan, resolveLocale, t, choose, type Locale } from "./i18n/index.js";

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
  buildTool?: string;
  lang?: string;
}

/** Per-invocation view of the global options. */
interface Invocation {
  json: boolean;
  project: string;
  buildTool?: string;
  /** The runtime locale: parsed `--lang`, else config, else en. */
  locale: Locale;
}

/** Context with the bootstrap's one notice line routed to stderr. */
function ctxFor(inv: Invocation): QueryContext {
  return openContext(inv.project, {
    onNotice: (msg) => process.stderr.write(`[jarpeek] ${msg}...\n`),
    buildToolFlag: inv.buildTool,
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
 * runs, never more. Only the prefix and the aggregate localize; the warning
 * payloads are core-produced diagnostics and stay as they are.
 */
function warn(locale: Locale, ...messages: string[]): void {
  const unique = [...new Set(messages)];
  if (unique.length === 0) return;
  const tr = catalog(locale);
  process.stderr.write(`${tr["warn.prefix"]}: ${unique[0]}\n`);
  if (unique.length > 1) {
    const n = unique.length - 1;
    const template = choose(locale, n, {
      one: tr["warn.more.one"],
      few: tr["warn.more.few"],
      many: tr["warn.more.many"],
      other: tr["warn.more.other"],
    });
    process.stderr.write(`${tr["warn.prefix"]}: ${t(template, { n })}\n`);
  }
}

/** Emit the result object in the mode the invocation asked for. */
function emit(result: unknown, inv: Invocation, render: () => string): void {
  process.stdout.write(inv.json ? `${renderJson(result)}\n` : `${render()}\n`);
}

/**
 * Print a miss-protocol answer to stdout. Misses are definitive answers, not
 * errors — the process exits 0 after this. The framing localizes; the note
 * and the searched coordinates are core contract surface and stay verbatim.
 */
function emitMiss(miss: MissResult, label: string, inv: Invocation): void {
  if (inv.json) {
    process.stdout.write(`${renderJson(miss)}\n`);
    return;
  }
  const tr = catalog(inv.locale);
  if (miss.found && miss.via === "fuzzy-candidates") {
    process.stdout.write(
      `${t(tr["miss.fuzzy"], { label })}\n${renderFindClassRows(miss.hits)}\n`,
    );
    return;
  }
  const searched =
    miss.searchedArtifacts.length > 0 ? miss.searchedArtifacts.join("\n  ") : tr["miss.none"];
  process.stdout.write(`${label} ${miss.note}\n${tr["miss.searched"]}\n  ${searched}\n`);
  // a miss born of a failed resolve carries the reason (spec decision #1):
  // the negative's degraded set warns through the same budgeted channel the
  // hits path uses, so "(none)" searched never reads as "nothing to resolve"
  if (miss.degraded.length > 0) warn(inv.locale, ...miss.degraded);
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

function renderMember(member: MemberSlice, fqn: string, provenance: string, locale: Locale): string {
  const tr = catalog(locale);
  const numbered = member.startLine > 0 ? numberLines(member.lines, member.startLine) : member.lines;
  const span =
    member.startLine > 0
      ? t(tr["render.spanLines"], { a: member.startLine, b: member.endLine })
      : tr["render.signatureOnly"];
  return [
    t(tr["render.memberHeader"], { fqn, selector: member.selector, span, provenance }),
    ...numbered,
  ].join("\n");
}

function renderReadMember(result: ReadMemberResult, locale: Locale): string {
  const tr = catalog(locale);
  const blocks = result.members.map((member) =>
    renderMember(member, result.fqn, result.provenance, locale),
  );
  return [
    ...blocks,
    ...result.misses.map((miss) =>
      t(tr["render.miss"], { selector: miss.selector, reason: miss.reason }),
    ),
    ...(result.alternatives?.map((alt) => t(tr["render.alternative"], { coords: alt.coordinates })) ?? []),
  ].join("\n\n");
}

function renderReadSource(result: ReadSourceResult, locale: Locale): string {
  const tr = catalog(locale);
  if (result.mode === "outline") {
    // unreachable from CLI flags (no flag selects outline mode) — kept so a
    // future flag and the MCP surface render the same skeleton, never a table
    return [
      renderSkeleton(result, resolveSections("outline", undefined), "summary", tr),
      ...(result.alternatives?.map((alt) => t(tr["render.alternative"], { coords: alt.coordinates })) ?? []),
    ].join("\n");
  }
  const header = t(tr["render.fileHeader"], { file: result.file, provenance: result.provenance });
  if (result.mode === "full") {
    return [
      `${header} ${t(tr["render.linesFull"], { n: result.lineCount })}`,
      ...numberLines(result.content.split("\n"), 1),
    ].join("\n");
  }
  const clamp = result.clamped ? tr["render.clamped"] : "";
  return [
    `${header} ${t(tr["render.linesOf"], { a: result.startLine, b: result.endLine, n: result.lineCount })}${clamp}`,
    ...numberLines(result.lines, result.startLine),
  ].join("\n");
}

function renderReadResource(result: ReadResourceResult, locale: Locale): string {
  const tr = catalog(locale);
  if (result.entries.length === 0) {
    return t(tr["render.noEntries"], { artifact: result.artifact, provenance: result.provenance });
  }
  return [
    t(tr["render.artifactHeader"], { artifact: result.artifact, provenance: result.provenance }),
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

function renderResolve(result: ResolveNowResult, locale: Locale): string {
  const tr = catalog(locale);
  const warnings =
    result.warnings.length > 0
      ? t(
          choose(locale, result.warnings.length, {
            one: tr["render.warningsSuffix.one"],
            few: tr["render.warningsSuffix.few"],
            many: tr["render.warningsSuffix.many"],
            other: tr["render.warningsSuffix.other"],
          }),
          { w: result.warnings.length },
        )
      : "";
  const resolved = t(
    choose(locale, result.artifactCount, {
      one: tr["render.resolved.one"],
      few: tr["render.resolved.few"],
      many: tr["render.resolved.many"],
      other: tr["render.resolved.other"],
    }),
    { n: result.artifactCount, ms: result.durationMs },
  );
  // the cap is presentation-only: --json prints the full array, a human gets
  // the first few and a pointer — a cache-scan resolve can carry one warning
  // per ambiguous g:a, and v1's line-spew must not come back through stdout
  const shown = result.warnings.slice(0, RESOLVE_WARNING_LINES);
  const rest = result.warnings.length - shown.length;
  return [
    `${resolved}${warnings}`,
    ...shown,
    ...(rest > 0 ? [t(tr["render.moreLine"], { n: rest })] : []),
  ].join("\n");
}

function renderWhere(result: WhereResult, locale: Locale): string {
  // one line per path, not a table: the paths are the payload and must never
  // be clipped by the 60-char column cap
  const tr = catalog(locale);
  return [
    t(tr["render.coordinates"], { coords: result.coordinates }),
    ...result.paths.map(
      (row) => `${row.role} ${row.path} ${row.exists ? tr["render.exists"] : tr["render.missing"]}`,
    ),
  ].join("\n");
}

// -- flag parsing --------------------------------------------------------------

/** `a:b` → {from, to}; non-numeric, 0-based, or inverted ranges are usage errors. */
function parseLinesFlag(value: string): { from: number; to: number } {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (match === null) {
    throw new InvalidArgumentError(t(ui["err.lines.format"], { value }));
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from < 1 || to < from) {
    throw new InvalidArgumentError(t(ui["err.lines.range"], { value }));
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
    throw new InvalidArgumentError(t(ui["err.positiveInt"], { value }));
  }
  return n;
}

function renderInit(result: InitResult, locale: Locale): string {
  const tr = catalog(locale);
  return [
    t(tr["render.buildSystems"], {
      list: result.detected.buildSystems.join(", ") || tr["render.none"],
    }),
    // jdk: is a proper-noun label; only the fallback parenthetical localizes
    `jdk: ${result.detected.jdk ?? tr["render.notDetected"]}`,
    ...result.wired.map((entry) =>
      t(tr["render.wired"], {
        harness: entry.harness,
        mode: entry.mode,
        targets: entry.targets.join(", "),
      }),
    ),
    ...result.notes.map((note) => t(tr["render.note"], { note })),
  ].join("\n");
}

// -- command surface -------------------------------------------------------------

/**
 * The build-time locale: commander constructs the program — descriptions,
 * option help, help blocks — before parsing, so these strings converge on
 * a raw-argv pre-scan of `--lang`/`--project` instead of parsed options.
 * Runtime actions re-resolve through the parsed `Invocation` (see
 * `invocation()`); a trailing `--lang ru` still localizes every output
 * site that renders after the parse.
 */
const scanned = preScan(process.argv.slice(2));
const buildLocale = resolveLocale({
  flag: scanned.lang,
  projectRoot: scanned.project ?? process.cwd(),
});
const ui = catalog(buildLocale);

const program = new Command();

program
  .name("jarpeek")
  .description(ui["cli.description"])
  .version(VERSION)
  .option("--json", ui["opt.json"])
  .option("--project <dir>", ui["opt.project"])
  .addOption(
    new Option(
      "--build-tool <strategy>",
      ui["opt.buildTool"],
    ).choices([...BUILD_TOOL_STRATEGIES]),
  )
  .addOption(new Option("--lang <locale>", ui["opt.lang"]).choices([...LOCALE_VALUES]))
  .addHelpText("after", () => topLevelHelp(catalog(buildLocale)));

/**
 * Declare a subcommand. Global flags are program-level and sticky.
 * `descKey`/`helpFn` come from the build-time catalog (help renders
 * before actions run).
 */
type CmdKey = Extract<keyof typeof ui, `cmd.${string}`>;

function command(name: string, descKey: CmdKey, helpFn?: (t: typeof ui) => string) {
  const sub = program.command(name);
  sub.description(ui[descKey]);
  if (helpFn !== undefined) {
    sub.addHelpText("after", () => helpFn(catalog(buildLocale)));
  }
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
  const project = opts.project ?? process.cwd();
  return {
    json: opts.json === true,
    project,
    buildTool: opts.buildTool,
    locale: resolveLocale({ flag: opts.lang, projectRoot: project }),
  };
}

command("find-class", "cmd.find-class", findClassHelp)
  .argument("<query>")
  .option("--limit <n>", ui["opt.limitHits"], parsePositiveInt, 20)
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
      if (result.degraded.length > 0) warn(inv.locale, ...result.degraded);
    });
  });

/** Flags of the outline subcommand: presets, section toggles, legacy table. */
interface OutlineCmd {
  kind?: DeclKind;
  visibility?: Visibility;
  minimal?: boolean;
  full?: boolean;
  imports?: boolean;
  fields?: boolean;
  methods?: boolean;
  inner?: boolean;
  javadoc?: boolean;
  table?: boolean;
}

command("outline", "cmd.outline", outlineHelp)
  .argument("<fqn>")
  // choice-constrained so an invalid value is a named usage error, and the
  // valid set renders into --help from the same arrays the MCP schema uses
  .addOption(new Option("--kind <k>", ui["opt.kind"]).choices(KIND_VALUES))
  .addOption(new Option("--visibility <v>", ui["opt.visibility"]).choices(VISIBILITY_VALUES))
  .option("--minimal", ui["opt.minimal"])
  .option("--full", ui["opt.fullOutline"])
  .option("--imports", ui["opt.imports"])
  .option("--no-imports", ui["opt.noImports"])
  .option("--fields", ui["opt.fields"])
  .option("--no-fields", ui["opt.noFields"])
  .option("--methods", ui["opt.methods"])
  .option("--no-methods", ui["opt.noMethods"])
  .option("--inner", ui["opt.inner"])
  .option("--no-inner", ui["opt.noInner"])
  .option("--javadoc", ui["opt.javadoc"])
  .option("--no-javadoc", ui["opt.noJavadoc"])
  .option("--table", ui["opt.table"])
  .action(async (fqn: string, cmd: OutlineCmd) => {
    const inv = invocation();
    if (cmd.minimal && cmd.full) {
      throw new InvalidArgumentError(catalog(inv.locale)["err.exclusive.minFull"]);
    }
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
      const hasOverrides = Object.values(toggles).length > 0;
      const overrides = hasOverrides ? toggles : undefined;
      const sections = resolveSections(preset, overrides);
      const result = await outline(ctx, fqn, {
        ...(cmd.kind !== undefined ? { kind: cmd.kind } : {}),
        ...(cmd.visibility !== undefined ? { visibility: cmd.visibility } : {}),
        preset,
        ...(overrides !== undefined ? { sections: overrides } : {}),
      });
      emit(result, inv, () => {
        const tr = catalog(inv.locale);
        const alternatives = result.alternatives?.map((alt) =>
          t(tr["render.alternative"], { coords: alt.coordinates }),
        );
        if (cmd.table) {
          return [
            t(tr["render.outlineTable"], {
              fqn: result.fqn,
              coords: result.coordinates,
              provenance: result.provenance,
            }),
            renderOutlineRows(result.rows),
            ...(alternatives ?? []),
          ].join("\n");
        }
        // the skeleton: same rows, code-shaped — full adds javadoc blocks
        // and body markers over the identical section booleans
        return [
          renderSkeleton(result, sections, preset === "full" ? "full" : "summary", tr),
          ...(alternatives ?? []),
        ].join("\n");
      });
      if (result.degraded.length > 0) warn(inv.locale, ...result.degraded);
    });
  });

command("read-member", "cmd.read-member", readMemberHelp)
  .argument("<fqn>")
  .argument("<selectors...>")
  .action(async (fqn: string, selectors: string[]) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      // space-separated args and one comma-joined string are the same list
      const result = await readMember(ctx, fqn, selectors.join(","));
      emit(result, inv, () => renderReadMember(result, inv.locale));
      // one warn call for the whole invocation: the budget is per run, not
      // per warn site, so misses and degradations share the two-line ceiling
      warn(
        inv.locale,
        ...result.misses.map((miss) => `${miss.selector}: ${miss.reason}`),
        ...result.degraded,
      );
    });
  });

command("read-source", "cmd.read-source", readSourceHelp)
  .argument("<fqn>")
  .option("--full", ui["opt.fullFile"])
  .option("--lines <a:b>", ui["opt.lines"])
  .action(async (fqn: string, cmd: { full?: boolean; lines?: string }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      if (cmd.full && cmd.lines !== undefined) {
        throw new InvalidArgumentError(catalog(inv.locale)["err.exclusive.fullLines"]);
      }
      const result = cmd.full
        ? await readSource(ctx, fqn, { mode: "full" })
        : cmd.lines !== undefined
          ? await readSource(ctx, fqn, { mode: "lines", ...parseLinesFlag(cmd.lines) })
          : await readSource(ctx, fqn);
      emit(result, inv, () => renderReadSource(result, inv.locale));
      if (result.degraded.length > 0) warn(inv.locale, ...result.degraded);
    });
  });

command("read-resource", "cmd.read-resource", readResourceHelp)
  .argument("<artifact>")
  .argument("<glob>")
  .action(async (artifact: string, glob: string) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await readResource(ctx, artifact, glob);
      emit(result, inv, () => renderReadResource(result, inv.locale));
    });
  });

command("search-symbols", "cmd.search-symbols", searchSymbolsHelp)
  .argument("<query>")
  .requiredOption("--artifact <coords>", ui["opt.artifact"])
  .option("--limit <n>", ui["opt.limitRows"], parsePositiveInt, 50)
  .addOption(new Option("--kind <k>", ui["opt.kind"]).choices(KIND_VALUES))
  .action(async (query: string, cmd: { artifact: string; limit: number; kind?: DeclKind }) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await searchSymbols(ctx, query, {
        artifact: cmd.artifact,
        limit: cmd.limit,
        ...(cmd.kind !== undefined ? { kind: cmd.kind } : {}),
      });
      emit(result, inv, () => {
        const tr = catalog(inv.locale);
        return result.rows.length > 0
          ? renderSearchSymbols(result)
          : t(tr["render.noSymbols"], { query });
      });
      if (result.degraded.length > 0) warn(inv.locale, ...result.degraded);
    });
  });

command("resolve", "cmd.resolve", resolveHelp).action(async () => {
  const inv = invocation();
  const ctx = ctxFor(inv);
  const result = await resolveNow(ctx);
  emit(result, inv, () => renderResolve(result, inv.locale));
  warn(inv.locale, ...result.degraded.map((entry) => `${entry.from}: ${entry.reason}`));
});

command("status", "cmd.status", statusHelp).action(async () => {
  const inv = invocation();
  const result = await status(ctxFor(inv));
  emit(result, inv, () => renderStatus(result));
  if (result.degraded.length > 0) warn(inv.locale, ...result.degraded);
});

command("where", "cmd.where", whereHelp)
  .argument("<coordinates>")
  .action(async (coordinates: string) => {
    const inv = invocation();
    const ctx = ctxFor(inv);
    await runQuery(inv, ctx, async () => {
      const result = await where(ctx, coordinates);
      emit(result, inv, () => renderWhere(result, inv.locale));
    });
  });

registerMcpCommand(program, ui);

command("prime", "cmd.prime", primeHelp)
  .option("--full", ui["opt.primeFull"])
  .option("--mcp", ui["opt.primeMcp"])
  .option("--export", ui["opt.primeExport"])
  .option("--hook-json", ui["opt.primeHookJson"])
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

command("init", "cmd.init", initHelp)
  .option("--yes", ui["opt.yes"])
  .action(async (cmd: { yes?: boolean }) => {
    const inv = invocation();
    const result = await runInit(inv.project, { yes: cmd.yes === true });
    emit(result, inv, () => renderInit(result, inv.locale));
  });

program.action((...rest: unknown[]) => {
  // the fallback fires only when no subcommand matched: bare invocation is a
  // legitimate "how do I use this" (help, exit 0), anything else is a typo'd
  // or invented command and must read as the usage error it is — v0.3 printed
  // help to stdout and exited 0, indistinguishable from success.
  // commander 12 contract: the last action parameter is the Command, and its
  // .args holds the positional operands (global flags already stripped)
  const cmd = rest.at(-1) as Command;
  const operands = cmd.args;
  if (operands.length === 0) {
    program.help();
  }
  // both directions: a typo can delete from the name (findclass ⊂ find-class)
  // or add to it (find-class ⊂ find-classes) — one subsequence direction
  // alone misses half the typos, so each candidate keeps its better score
  const candidates = program.commands
    .map((c) => c.name())
    .filter((name) => name !== "help");
  const scored = candidates
    .map((name) => {
      const forward = fuzzyScore(operands[0]!, name);
      const backward = fuzzyScore(name, operands[0]!);
      const best = forward === null ? backward : backward === null ? forward : Math.max(forward, backward);
      return best === null ? null : { name, score: best };
    })
    .filter((entry): entry is { name: string; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score);
  const suggestion = scored.length > 0 ? scored[0]!.name : undefined;
  const tr = catalog(invocation().locale);
  throw new InvalidArgumentError(
    suggestion !== undefined
      ? t(tr["err.unknownCommand"], { name: operands[0]!, suggestion })
      : t(tr["err.unknownCommandPlain"], { name: operands[0]! }),
  );
});

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // the fatal prefix localizes through the build-time catalog (a parse-time
  // failure never reaches a parsed Invocation); the payload stays verbatim
  process.stderr.write(
    error instanceof SelectorError || error instanceof InvalidArgumentError
      ? `${message}\n`
      : `${ui["err.fatal"]}: ${message}\n`,
  );
  process.exit(EXIT_FATAL);
});
