# Agent-grade CLI help and teaching errors — discoverability redesign

**Status:** in_progress

## Problem

Agents that reach `jarpeek` cold — no `init` wiring, no cheatsheet in context,
only the CLI itself — misuse the tool in three observed ways:

1. **Invented flags** (`--format`, `--type`) — the flag exists in the agent's
   imagination but not on the command.
2. **Right flag, wrong value** — `--kind` accepts eleven values and
   `--visibility` four, and nowhere in the help are they enumerated. The CLI
   casts values blindly (`as DeclKind`), so a wrong guess (`--kind methods`)
   is not an error: it filters to an empty answer.
3. **Missed capability** — agents dump whole files with `read-source` because
   nothing they can see tells them `outline` and `read-member` are the
   frugal entry points.

Three surface defects cause this:

- `--help` is stock commander output: one-line descriptions, no examples, no
  valid values, no decision guidance.
- An unrecognized command (`jarpeek find-classes X`) prints the full help to
  **stdout and exits 0** — a typo is indistinguishable from success.
- The purpose-built agent cheatsheet (`jarpeek prime --full`) exists, but a
  cold agent has no way to learn it exists.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | Fix only the surfaces a cold agent touches: `--help` output and usage errors. No new commands, no LLM-detection heuristics, no `llms.txt`. |
| 2 | `--kind` and `--visibility` values become **commander `choices()`** on `outline`, and `--kind` on `search-symbols` — invalid values exit 1 naming the allowed set. The blind `as DeclKind` / `as Visibility` casts disappear. |
| 3 | Valid values live in **one shared module** (`src/core/enums.ts`), moved out of `src/mcp/server.ts` with their exhaustiveness checks. Consumers: MCP zod enums, CLI choices, help text interpolation. |
| 4 | Help content lives in a new `src/cli/help.ts`, attached via commander's `addHelpText` **after** the default output; prose is hand-authored next to command registration, enum lists are interpolated from the shared module. |
| 5 | **Unknown command becomes a usage error**: `unknown command 'find-classes' — did you mean 'find-class'? (see: jarpeek --help)` on stderr, **exit 1**. Bare `jarpeek` (no arguments) still prints help and exits 0. Unknown-**flag** did-you-mean stays as commander ships it. |
| 6 | Every help level points one rung up the ladder: top-level help ends with `full agent cheatsheet: jarpeek prime --full`. |
| 7 | Miss protocol is untouched: misses stay exit-0 answers on stdout. Only the usage-error path changes semantics (unknown command 0 → 1). |

## Design

### Shared value enums

`src/core/enums.ts` exports `KIND_VALUES` (eleven declaration kinds) and
`VISIBILITY_VALUES` (four), with the exhaustive-check types that currently
sit in `src/mcp/server.ts`. `server.ts` imports them for its zod enums —
MCP behavior is byte-identical. The CLI imports the same arrays for flag
choices and help interpolation; the values can no longer drift between the
three surfaces.

### Flag validation

`outline --kind` / `--visibility` and `search-symbols --kind` declare
commander choices built from the shared arrays. An invalid value produces
commander's standard choice error (`choices are …, got "methods"`), exit 1,
stderr — the same channel and code as every other usage error. The option
help lines list the values too, so `--help` alone prevents the guess.

### Help architecture

`src/cli/help.ts` holds the appended help blocks; registration stays in
`src/cli/index.ts`. Layout contract:

- **Top level** (~35 lines): a four-line *frugal path* narrative —
  `find-class` to locate, `outline` for the shape, `read-member` for exactly
  the member, `read-source` only when the whole file is warranted — followed
  by five copy-pasteable examples with realistic arguments, followed by the
  prime pointer line.
- **Per command** (~10–15 lines): two to three examples, every flag with its
  default, enumerated values where a flag is choice-constrained, selector
  syntax where relevant (`#name`, `#name(T1,T2)`), and one `related:` line
  naming the cheaper alternative (`read-source` points at `outline` and
  `read-member`; `outline --table` at the default skeleton view).

Line counts are guidance for review, not runtime-enforced budgets. The
default commander section (usage line, options table) stays; the appended
block completes it rather than replacing it.

### Unknown command

The `program.action(() => program.help())` fallback is replaced: with no
arguments the program prints help, exit 0; with an unrecognized leading
argument it prints the suggestion line above — commander's suggestion
machinery names the closest registered command — and exits 1 through the
existing fatal handler.

## Error contract (restated whole)

- Usage errors (malformed selectors, bad values, unknown flags, unknown
  commands, IO): stderr, exit 1.
- Misses: stdout, exit 0 — unchanged.
- Help: stdout, exit 0, only on explicit request (`--help`, `-h`, bare
  `jarpeek`).

## Testing

- Choice rejection: `outline <fqn> --kind methods` exits 1 and the message
  names every valid kind; same for `--visibility` and `search-symbols`.
- Unknown command: `find-classes` exits 1 with a line containing
  `find-class`; bare `jarpeek` exits 0 with help on stdout.
- Help containment: top-level help contains the frugal-path sentence, five
  examples, and the `prime --full` pointer; each subcommand's help contains
  its examples and (where applicable) the enumerated values.
- Regression: existing flag-parse, miss-protocol, and MCP parity tests stay
  green; `server.ts` enum consumers test unchanged through the same zod
  schemas.

## Open Questions

None.
