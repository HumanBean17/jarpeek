/**
 * The English message catalog: the source of truth every other locale is
 * typed against (`type Catalog = typeof en`). Values are plain strings;
 * `{name}` tokens are filled by `t()`, plural variants by `choose()`.
 * Adding a string means adding a key here and the translation in `ru.ts`
 * in the same change — the compiler rejects a partial catalog, so locales
 * cannot drift silently. Keys are dot-namespaced by surface:
 * `cli.*`/`opt.*`/`cmd.*` (build-time descriptions), `help.*`/`related.*`
 * (help blocks), `miss.*`/`warn.*`/`err.*`/`render.*` (runtime output).
 */
export const en = {
  // -- program and global flags ---------------------------------------------
  "cli.description": "Dependency source access for AI agents on JVM projects",
  "opt.json": "machine-readable output (the exact MCP result object)",
  "opt.project": "project root (default: cwd)",
  "opt.buildTool":
    "which mvn/gradle runs resolves: system from PATH, the root wrapper, or system-first with wrapper fallback (default)",
  "opt.lang": "interface language for human-mode output (en, ru)",

  // -- subcommand descriptions ------------------------------------------------
  "cmd.find-class": "find classes by FQN, suffix, simple name, or fuzzy name",
  "cmd.outline":
    "java-shaped class skeleton (presets + section toggles; --table for the legacy view)",
  "cmd.read-member": "source slices for member selectors (#name, #name(T1,T2))",
  "cmd.read-source": "source text for one class (outline | full | lines)",
  "cmd.read-resource": "non-class jar entries (config, services, manifests)",
  "cmd.search-symbols": "find declarations by member name in one artifact",
  "cmd.resolve": "force a dependency resolve pass",
  "cmd.status": "manifest and JVM report",
  "cmd.where": "on-disk paths for one artifact",
  "cmd.mcp": "serve the MCP stdio server for this project",
  "cmd.prime": "the jarpeek cheatsheet for agents (this file)",
  "cmd.init": "wire AI harnesses (MCP server or CLI hints) for this project",

  // -- per-command option help -------------------------------------------------
  "opt.kind": "filter by declaration kind",
  "opt.visibility": "filter by visibility",
  "opt.minimal": "preset: no imports, no fields, no javadoc",
  "opt.fullOutline": "preset: everything, javadoc blocks and body markers",
  "opt.imports": "show imports (overrides the preset)",
  "opt.noImports": "hide imports (overrides the preset)",
  "opt.fields": "show fields/properties/enum constants (overrides the preset)",
  "opt.noFields": "hide fields/properties/enum constants (overrides the preset)",
  "opt.methods": "show methods/constructors (overrides the preset)",
  "opt.noMethods": "hide methods/constructors (overrides the preset)",
  "opt.inner": "show nested classes (overrides the preset)",
  "opt.noInner": "hide nested classes (overrides the preset)",
  "opt.javadoc": "show javadoc (overrides the preset)",
  "opt.noJavadoc": "hide javadoc (overrides the preset)",
  "opt.table": "the legacy tabular view over the same rows",
  "opt.limitHits": "max hits",
  "opt.limitRows": "max rows",
  "opt.fullFile": "the whole file",
  "opt.lines": "line range, e.g. 2:3",
  "opt.artifact": "g:a:v coordinates or unique artifact id",
  "opt.primeFull": "the full cli cheatsheet (default without MCP wiring)",
  "opt.primeMcp": "the short mcp card",
  "opt.primeExport": "the default content even when .jarpeek/PRIME.md exists",
  "opt.primeHookJson": "wrap the text as a SessionStart hook additionalContext payload",
  "opt.yes": "non-interactive: claude + mcp defaults",

  // -- help-block prose ----------------------------------------------------------
  "help.frugal":
    "the frugal path: find-class to locate the class, outline for its shape, read-member for exactly the member's code — read-source only when you need the whole file.",
  "help.examples": "Examples:",
  "help.related": "related:",
  "help.primePointer": "full agent cheatsheet: jarpeek prime --full",
  "help.mcp": "serves the stdio MCP server; jarpeek init writes the harness configs that launch it.",
  "help.prime":
    "--full produces the full agent cheatsheet; --export bypasses a .jarpeek/PRIME.md override.",
  "help.init": "non-interactive wiring (Claude Code + MCP).",

  // -- related: cross-link sentences ----------------------------------------------
  "related.find-class": "outline <fqn> shows a hit's shape.",
  "related.outline": "read-member returns one member's code; --table keeps the legacy tabular view.",
  "related.read-member": "read-source --lines a:b for surrounding context.",
  "related.read-source": "cheaper first — outline, then read-member.",
  "related.read-resource": "where <coords> for the artifact's on-disk paths.",
  "related.search-symbols": "find-class when you don't know which artifact holds the class.",
  "related.resolve": "status reports what the manifest now holds.",
  "related.status": "resolve forces a re-resolve.",
  "related.where": "read-resource reads non-class entries of the same artifact.",

  // -- runtime: the warning channel (plural families feed choose()) ----------------
  "warn.prefix": "warning",
  "warn.more.one": "+{n} more (see: jarpeek status)",
  "warn.more.few": "+{n} more (see: jarpeek status)",
  "warn.more.many": "+{n} more (see: jarpeek status)",
  "warn.more.other": "+{n} more (see: jarpeek status)",

  // -- runtime: miss-protocol rendering ----------------------------------------------
  "miss.fuzzy": "no indexed class for {label}; did you mean:",
  "miss.searched": "searched:",
  "miss.none": "(none)",

  // -- runtime: usage errors ------------------------------------------------------------
  "err.lines.format": "--lines expects from:to (e.g. 2:3), got \"{value}\"",
  "err.lines.range": "--lines expects 1-based from:to with to >= from, got \"{value}\"",
  "err.positiveInt": "expected a positive integer, got \"{value}\"",
  "err.exclusive.minFull": "--minimal and --full are mutually exclusive",
  "err.exclusive.fullLines": "--full and --lines are mutually exclusive",
  "err.unknownCommand": "unknown command '{name}' — did you mean '{suggestion}'? (see: jarpeek --help)",
  "err.unknownCommandPlain": "unknown command '{name}' (see: jarpeek --help)",
  "err.fatal": "error",
  // -- runtime: human renderers -------------------------------------------
  "render.spanLines": "lines {a}–{b}",
  "render.signatureOnly": "signature only",
  "render.memberHeader": "{fqn}#{selector}  ({span}  provenance {provenance})",
  "render.miss": "miss {selector}: {reason}",
  "render.alternative": "alternative: {coords}",
  "render.fileHeader": "file {file} provenance {provenance}",
  "render.linesFull": "lines 1-{n}",
  "render.linesOf": "lines {a}-{b} of {n}",
  "render.clamped": " (clamped)",
  "render.artifactHeader": "artifact {artifact} provenance {provenance}",
  "render.noEntries": "artifact {artifact}: no matching entries (provenance {provenance})",
  "render.noSymbols": "no symbols found for {query}",
  "render.resolved.one": "resolved {n} artifacts in {ms}ms",
  "render.resolved.few": "resolved {n} artifacts in {ms}ms",
  "render.resolved.many": "resolved {n} artifacts in {ms}ms",
  "render.resolved.other": "resolved {n} artifacts in {ms}ms",
  "render.warningsSuffix.one": " ({w} warnings)",
  "render.warningsSuffix.few": " ({w} warnings)",
  "render.warningsSuffix.many": " ({w} warnings)",
  "render.warningsSuffix.other": " ({w} warnings)",
  "render.moreLine": "+{n} more (see: jarpeek status)",
  "render.coordinates": "coordinates {coords}",
  "render.exists": "(exists)",
  "render.missing": "(missing)",
  "render.buildSystems": "build systems: {list}",
  "render.none": "(none)",
  "render.notDetected": "(not detected)",
  "render.wired": "wired {harness} ({mode}): {targets}",
  "render.note": "note: {note}",
  "render.outlineTable": "{fqn}  {coords}  provenance {provenance}",

  // -- skeleton view (outline's default; --table uses render.outlineTable) --
  "skeleton.header": "{coords}  provenance {provenance}",
  "skeleton.stale": "stale index served",
};

/** The shape every locale's catalog must satisfy exactly. */
export type Catalog = typeof en;
