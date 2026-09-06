# CLI localization — Russian locale via `--lang` and config

**Status:** in_progress

## Problem

Every human-facing string jarpeek prints — help texts, human-mode renderers,
usage errors, stderr warnings — is hardcoded English inline at each output
site (`src/cli/help.ts`, `src/cli/index.ts`, `src/cli/render.ts`). A
Russian-speaking human reading the terminal output has no way to switch the
interface language, and there is no mechanism through which any second
language could be added.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | Scope is **human-mode output only**: help texts, human renderers (tables, miss answers, resolve/status output), stderr warnings, usage errors. The `--json` output, the MCP server, and the `prime` cheatsheet stay English — they are machine/agent contracts. |
| 2 | Strings composed in the **CLI layer** are localized. Strings produced by **core/resolver** (degraded warnings, miss `note`, `cache-scan-truncated:N` style tokens) stay English even in ru mode — they are semi-machine diagnostics shared with the `--json` contract. |
| 3 | Architecture: **extensible typed catalogs**. A flat English catalog is the source of truth; `type Catalog = typeof en`; each additional locale is a `Catalog` — the compiler forces complete coverage, no silent runtime fallback. A new locale is a new catalog file plus registration. |
| 4 | Activation: sticky global `--lang <en\|ru>` flag (like `--json`) plus a `language` field in `.jarpeek/config.json`. Precedence **flag > config > `en`**. No env var (deliberate — the user declined it). Absent/corrupt/invalid config values fall through to the next layer, matching `primeMode` behavior; an invalid flag value is a commander `choices` error. |
| 5 | No i18n library. Parameter interpolation is simple `{name}` substitution; Russian plural forms use Node's built-in `Intl.PluralRules`. Zero new dependencies. |

## Design

### i18n module

New `src/cli/i18n/` directory:

- `en.ts` — the English catalog: one flat object keyed by message id
  (`"cli.description"`, `"find-class.description"`, `"outline.header"`,
  `"warn.more"`, …). Source of truth.
- `ru.ts` — `export const ru: Catalog` where `Catalog = typeof en`. Compiler
  error on any missing key; `ru.ts` importing the type from `en.ts` keeps the
  coupling explicit.
- `index.ts` — `Locale` type (`"en" | "ru"`), `LOCALE_VALUES` array (for the
  commander `choices` and tests), `catalog(locale)` accessor, the `t()`
  helper for `{param}` interpolation, and `choose(locale, count, forms)`
  plural selection backed by `Intl.PluralRules`.

Message values are plain strings; `t()` covers named-parameter
substitution, and counted strings come from plural key families
(`key.one`/`few`/`many`/`other`) selected by `choose()`. Commands names,
flag names, FQNs, coordinates, and file paths are never translated — they
are copy-pasteable invocation surface.

### Locale convergence

`resolveLocale(opts: { flag?: string; projectRoot: string }): Locale` in
`src/cli/i18n/index.ts`: the parsed `--lang` value when present and valid,
else the `language` field of `.jarpeek/config.json` (read via the same
absent/corrupt/invalid → fall-through contract as `readPrimeModeConfig`),
else `"en"`. The i18n module keeps its own `CONFIG_PATH` constant (same
`.jarpeek/config.json` value) so it imports nothing from `src/prime/`.

### Program construction: the pre-scan

Commander builds the program — `.description()` strings, option help, help
blocks — at module load, before flags are parsed. `src/cli/index.ts` gains a
small `preScan(argv: string[]): { lang?: string; project?: string }` that
scans the raw argv for `--lang <v>` / `--lang=<v>` and
`--project <dir>` / `--project=<dir>` (stopping at `--`); `resolveLocale`
consumes that result for all build-time strings. Runtime actions
re-resolve through the parsed
`Invocation` (`resolveLocale({ flag: opts.lang, projectRoot: inv.project })`)
and pass the catalog into renderers — so trailing global flags
(`jarpeek find-class X --lang ru`) localize every output site even though
help was built at load time.

### Catalog consumers

- `help.ts` — each help-block constant becomes a function of the catalog
  (`(t: Catalog) => string`); the `Examples:` command lines stay verbatim,
  the surrounding prose ("related:", guidance) translates.
- `index.ts` — program/subcommand descriptions, option descriptions, usage
  errors (`parseLinesFlag`, `parsePositiveInt`, mutual-exclusion errors,
  unknown-command suggestion), `warn()` lines ("warning:", "+N more (see …)"),
  miss rendering ("no indexed class for …; did you mean:", "searched:",
  "(none)"), and the human renderers (`renderMember` spans,
  "signature only", "miss …", "alternative:", "no symbols found for …",
  "resolved N artifacts in Xms", "+N more", renderWhere/renderInit labels).
- `render.ts` — unchanged: `renderStatus` output is entirely schema tokens
  (KEY column names config surface, values are paths/numbers) and stays
  verbatim per the rule below, so it gains no catalog parameter.
- `mcp-command.ts` — the one-line command description and MCP_HELP prose
  translate; the server itself does not.

Counts (artifactCount, warnings, "+N more") render through `choose()`:
Russian uses one/few/many via `Intl.PluralRules`; English one/other.

### What stays verbatim in both locales

Sentences translate; schema-shaped tokens do not. Verbatim in both locales:
command and flag names, FQNs, coordinates, paths, table column headers
(FQN, KIND, ARTIFACT, PROVENANCE, SELECTOR, VIS, STATIC, DEP, SIGNATURE,
PATH, SIZE, CONTENT, KEY, VALUE), the enum-ish cell values under them
(`method`, `static`, `dep`, provenance labels, where-roles), the status
table's KEY column, and every string produced by core/resolver (decision #2).
Translating a header but not its cells — or vice versa — would read as
mixed language; the tokens are the schema both locales share.

### Docs

README gains a short "Language" note under configuration: the `--lang` flag
and the `language` config field with the precedence chain.
`docs/design.md` gains a decision-log entry recording the human-mode-only
boundary and the CLI-layer/core-layer string split.

## Testing

- Convergence: flag > config > `en`; corrupt/absent/invalid config falls
  through; invalid flag value exits 1 with the choices named.
- Catalog: `ru` covers every `en` key with a non-empty string (compile-time
  by typing; a runtime guard test keeps generated/built output honest).
- Interpolation and plurals: `t()` substitutes params; `choose()` returns
  correct ru forms for 1/2/5/11/21/25 and en one/other for 1/2.
- Rendering: per command family (find-class, outline, read-member,
  read-source, read-resource, search-symbols, resolve, status, where, init,
  miss paths, warn budget lines) — a ru-locale assertion on the human output
  string(s), against stubbed contexts where the query needs one.
- Help: `--lang ru --help` and one subcommand help render Russian prose with
  untranslated command examples.
- Regression: default-invocation output is byte-identical to today (existing
  tests, untouched, are the oracle).

## Open Questions

None.
