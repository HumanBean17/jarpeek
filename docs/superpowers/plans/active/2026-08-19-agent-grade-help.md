# Agent-Grade CLI Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cold agent reaches a correct jarpeek invocation from `--help` and error output alone — no invented flags, no wrong values, no missed cheaper commands.

**Architecture:** Three changes in the CLI layer: (1) declaration-kind/visibility value arrays move to a shared `src/core/enums.ts` consumed by MCP zod schemas and CLI flag choices; (2) `--kind`/`--visibility` flags become commander choice-constrained options (invalid values exit 1 naming the allowed set, and commander auto-renders the values into help); (3) a new `src/cli/help.ts` appends examples + `related:` cross-links to every help level, and the unknown-command fallback becomes a stderr error with a did-you-mean suggestion, exit 1.

**Tech Stack:** TypeScript (ESM, `tsc` strict), commander 12.1.0 (already a dependency — verified behaviors below), vitest 4.

## Global Constraints

- No new npm dependencies. Commander is pinned at the installed 12.1.0.
- Miss protocol untouched: misses stay stdout + exit 0. Only the usage-error path changes (unknown command flips 0 → 1).
- stdout carries answers and explicit `--help` output only; usage errors go to stderr.
- The stderr three-line warning budget (`warn()` in `src/cli/index.ts`) is untouched — help and usage errors are not warnings.
- Verified commander 12.1.0 behaviors (probed against the installed package — rely on these exact strings):
  - Choice violation: stderr `error: option '--kind <k>' argument 'methods' is invalid. Allowed choices are method, field, class.` then process exits 1.
  - Choice declaration auto-renders in help: `--kind <k>  filter by declaration kind (choices: "method", "field", "class")`. **Therefore help.ts never hand-writes enum lists** — the spec's no-drift intent is met by feeding the shared arrays to `choices()`.
  - Unknown flag did-you-mean (`Did you mean --kind?`) is built-in — do not reimplement.
  - A program-level `action` handler receives every unmatched invocation; the last callback parameter is the `Command`, whose `.args` holds the positional operands (probed: `["find-classes","X"]`).
- Comment style: file-header and function comments explain *why*, one dense paragraph, matching `src/cli/index.ts`.
- Test invocation: `npx vitest run <file>` from repo root (spawns use `npx tsx src/cli/index.ts`, the pattern in `test/unit/cli-smoke.test.ts`).
- Commit messages follow the repo's conventional style (e.g. `feat(cli): …`, `refactor: …`).

---

### Task 1: Shared value enums module

**Files:**
- Create: `src/core/enums.ts`
- Modify: `src/mcp/server.ts:30-66` (delete the local definitions, import from the new module)
- Test: `test/unit/enums.test.ts`

**Interfaces:**
- Consumes: `DeclKind` and `Visibility` unions from `src/core/types.ts` (`DeclKind` = `class | interface | enum | record | annotation | object | method | constructor | field | property | enum-constant`; `Visibility` = `public | protected | package | private`).
- Produces: `src/core/enums.ts` exports `KIND_VALUES` and `VISIBILITY_VALUES` — readonly string arrays with the exact values and order currently in `src/mcp/server.ts:31-43` and `51-56` (`KIND_VALUES` in the order class, interface, enum, record, annotation, object, method, constructor, field, property, enum-constant), each declared `as const satisfies readonly DeclKind[]` / `readonly Visibility[]`, with the two exhaustiveness-check aliases and their forcing consts moved verbatim. `server.ts` keeps its `KIND_ENUM = z.enum(KIND_VALUES)` / `VISIBILITY_ENUM` lines, now importing the arrays; MCP wire behavior is byte-identical.

- [x] **Step 1: Write the failing test**

Create `test/unit/enums.test.ts` with two cases: (1) `KIND_VALUES` deep-equals the exact 11-value ordered list above; (2) `VISIBILITY_VALUES` deep-equals `["public", "protected", "package", "private"]`. Import from `../src/core/enums.js`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/enums.test.ts`
Expected: FAIL — cannot resolve `../src/core/enums.js` (module does not exist).

- [x] **Step 3: Write minimal implementation**

Create `src/core/enums.ts` with the two arrays, their `satisfies` clauses, and the moved exhaustiveness checks (keep the existing explanatory comments about the conditional-type trick). Edit `src/mcp/server.ts`: delete lines 30-63 (the two array definitions and their checks), add `KIND_VALUES`/`VISIBILITY_VALUES` to the import from `../core/enums.js`, leave the `z.enum` lines and every tool schema untouched.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/enums.test.ts test/unit/cli-smoke.test.ts test/integration/mcp.test.ts && npm run typecheck`
Expected: all PASS (mcp.test.ts proves the server rewiring changed nothing), typecheck clean.

- [x] **Step 5: Commit**

Run: `git add src/core/enums.ts src/mcp/server.ts test/unit/enums.test.ts`
Run: `git commit -m "refactor: shared decl-kind/visibility enums in core/enums.ts"`

---

### Task 2: Choice-constrained `--kind` / `--visibility` flags

**Files:**
- Modify: `src/cli/index.ts` — outline options block (currently lines 379-393) and search-symbols options (currently lines 493-495); the `OutlineCmd` interface (lines 361-372) and the search-symbols action's inline cmd type (line 496)
- Test: `test/unit/cli-smoke.test.ts` (extend; the `runCli` helper already exists there)

**Interfaces:**
- Consumes: `KIND_VALUES`, `VISIBILITY_VALUES` from `src/core/enums.js` (Task 1); commander's `Option` class alongside the existing `Command`/`InvalidArgumentError` imports.
- Produces: three flags become choice-constrained: `outline --kind <k>` (choices = `KIND_VALUES`), `outline --visibility <v>` (choices = `VISIBILITY_VALUES`), `search-symbols --kind <k>` (choices = `KIND_VALUES`). Option descriptions keep their current text ("filter by declaration kind" / "filter by visibility"). The `OutlineCmd` interface tightens `kind?: DeclKind` and `visibility?: Visibility` (was `string`), and the actions drop the `as DeclKind` / `as Visibility` casts — a valid choice is guaranteed by the parser. Later tasks and MCP parity rely on no other surface change: `--json` payloads, renderer calls, and miss behavior are byte-identical for valid values.

- [x] **Step 1: Write the failing tests**

Extend `test/unit/cli-smoke.test.ts` with a `describe("flag value validation")` containing four cases, each via `runCli`:

1. `["outline", "Foo", "--kind", "methods"]` → `code === 1`, `stdout === ""`, `stderr` contains `Allowed choices are` and the strings `method` and `enum-constant` (the first and last of the eleven).
2. `["outline", "Foo", "--visibility", "publicish"]` → `code === 1`, `stderr` contains `Allowed choices are` and `package`.
3. `["search-symbols", "builder", "--artifact", "g:a:1", "--kind", "methods"]` → `code === 1`, `stderr` contains `Allowed choices are`.
4. `["outline", "--help"]` → `code === 0`, `stdout` contains `(choices:` and `enum-constant` (commander auto-renders the declared choices into the options table).

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-smoke.test.ts`
Expected: the three validation cases FAIL with `code` 0 (or a different stderr — today a wrong `--kind` silently filters results); the help case FAILS (no `(choices:` in output). The pre-existing three smoke cases still PASS.

- [x] **Step 3: Write minimal implementation**

In `src/cli/index.ts`: import `Option` from commander and the two arrays from `../core/enums.js`. For outline, replace the two string-style `.option()` calls for `--kind`/`--visibility` with `addOption(new Option("--kind <k>", "filter by declaration kind").choices(...))` and the visibility twin (if the TS typings demand a mutable array, spread: `choices([...KIND_VALUES])`); leave the preset/toggle flags as they are. Do the same for search-symbols `--kind`. Update `OutlineCmd` field types and remove the casts in both action bodies (pass `cmd.kind` / `cmd.visibility` straight through).

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli-smoke.test.ts test/unit/enums.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean (the tightened `OutlineCmd` types must not break the outline action).

- [x] **Step 5: Commit**

Run: `git add src/cli/index.ts test/unit/cli-smoke.test.ts`
Run: `git commit -m "feat(cli): choice-validate --kind/--visibility, values render in help"`

---

### Task 3: Unknown command exits 1 with did-you-mean

**Files:**
- Modify: `src/cli/index.ts` — the fallback action (currently lines 569-571)
- Test: `test/unit/cli-smoke.test.ts` (extend)

**Interfaces:**
- Consumes: `topMatches<T>(items: T[], label: (t: T) => string, query: string, limit: number): Array<{ item: T; score: number }>` from `src/core/fuzzy.ts` (returns ranked fuzzy matches, non-matches dropped); `InvalidArgumentError` from commander (the existing fatal catch prints its message bare — no `error:` prefix — and exits 1); the registered subcommand names on `program.commands` (commander also auto-registers `help` — exclude it from candidates).
- Produces: the program fallback behavior other tooling depends on: bare `jarpeek` (no operands) prints help to stdout, exit 0 — unchanged. Any unmatched first operand throws `InvalidArgumentError` whose message is exactly `unknown command 'find-classes' — did you mean 'find-class'? (see: jarpeek --help)` when a suggestion exists, or `unknown command 'frobnicate' (see: jarpeek --help)` when none does. A suggestion exists iff some command name fuzzy-matches the operand — implemented as `fuzzyScore` scored in **both directions** per candidate (query=operand→target=name and query=name→target=operand), keeping each candidate's max: one direction alone misses typos that lengthen the name (`find-classes` is not a subsequence of `find-class`, but the reverse matches). Candidates are the 12 command names (find-class, outline, read-member, read-source, read-resource, search-symbols, resolve, status, where, mcp, prime, init — `help` excluded), ranked score-descending; the suggestion is the top name. Exit 1, stderr.

- [x] **Step 1: Write the failing tests**

Extend `test/unit/cli-smoke.test.ts` with a `describe("unknown command")` containing three cases via `runCli`:

1. `["find-classes", "Foo"]` → `code === 1`, `stdout === ""`, `stderr` contains `unknown command 'find-classes'` and `did you mean 'find-class'` and `(see: jarpeek --help)`.
2. `["frobnicate"]` → `code === 1`, `stderr` contains `unknown command 'frobnicate'` and does NOT contain `did you mean`.
3. The pre-existing case `[]` (bare invocation) still exits 0 with `Usage:` on stdout — keep it green (it already exists as "no args prints help with Usage and subcommands, exit 0").

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-smoke.test.ts`
Expected: the two new cases FAIL — today both print help to stdout and exit 0. The bare-invocation case still PASSES.

- [x] **Step 3: Write minimal implementation**

Replace the body of the fallback `program.action` in `src/cli/index.ts`: read the operands from the `Command` parameter's `.args`; when empty, call `program.help()` as today; otherwise build the message per the contract above (candidate list = `program.commands` names minus `help`, suggestion = the best both-directions `fuzzyScore` candidate when any matches) and `throw new InvalidArgumentError(message)` — the existing `parseAsync().catch` already prints it bare to stderr and exits 1.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli-smoke.test.ts`
Expected: all PASS, including the pre-existing bare-invocation and flag-validation cases.

- [x] **Step 5: Commit**

Run: `git add src/cli/index.ts test/unit/cli-smoke.test.ts`
Run: `git commit -m "feat(cli): unknown command exits 1 with did-you-mean suggestion"`

---

### Task 4: Help content — examples, related links, frugal path

**Files:**
- Create: `src/cli/help.ts`
- Modify: `src/cli/index.ts` — the `command()` helper (currently lines 325-329) gains an optional help-text parameter; one `program.addHelpText("after", …)` call for the top level
- Test: `test/unit/cli-help.test.ts` (new; copy the 12-line `runCli` helper pattern from `test/unit/cli-smoke.test.ts` — helper duplication across test files is accepted here)

**Interfaces:**
- Consumes: nothing from earlier tasks (enum values in help come from commander's auto-rendered `(choices: …)`, Task 2 — help.ts carries no enum lists).
- Produces: `src/cli/help.ts` exports one constant per help block, all plain strings starting with a blank line (commander appends them under its default output):
  - `TOP_LEVEL_HELP` — contains, in order: the frugal-path sentence exactly `the frugal path: find-class to locate the class, outline for its shape, read-member for exactly the member's code — read-source only when you need the whole file.`; an `Examples:` section with exactly these five lines: `jarpeek find-class StringJoiner --limit 5`, `jarpeek outline java.util.StringJoiner --kind method`, `jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'`, `jarpeek read-source com.example.lib.ApiClient --lines 40:80`, `jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method`; and a final line exactly `full agent cheatsheet: jarpeek prime --full`.
  - Per-command example blocks, each shaped as: blank line, `Examples:`, one to three example lines, one `related:` sentence. Names and mandated content (example lines verbatim, related text as the stated meaning):
    - `FIND_CLASS_HELP`: examples `jarpeek find-class StringJoiner --limit 5` and `jarpeek find-class com.example.lib.ApiClient`; related: `outline <fqn>` shows a hit's shape.
    - `OUTLINE_HELP`: examples `jarpeek outline java.util.StringJoiner --kind method`, `jarpeek outline java.util.StringJoiner --minimal`, `jarpeek outline com.example.lib.ApiClient --no-fields`; related: `read-member` returns one member's code; `--table` keeps the legacy tabular view.
    - `READ_MEMBER_HELP`: examples `jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'` and `jarpeek read-member com.example.lib.ApiClient '#builder' '#build()'`; related: `read-source --lines a:b` for surrounding context.
    - `READ_SOURCE_HELP`: examples `jarpeek read-source com.example.lib.ApiClient --lines 40:80` and `jarpeek read-source com.example.lib.ApiClient --full`; related: cheaper first — `outline`, then `read-member`.
    - `READ_RESOURCE_HELP`: example `jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'`; related: `where <coords>` for the artifact's on-disk paths.
    - `SEARCH_SYMBOLS_HELP`: example `jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method`; related: `find-class` when you don't know which artifact holds the class.
    - `RESOLVE_HELP`: example `jarpeek resolve`; related: `status` reports what the manifest now holds.
    - `STATUS_HELP`: example `jarpeek status`; related: `resolve` forces a re-resolve.
    - `WHERE_HELP`: example `jarpeek where com.example:demo-lib:1.0.0`; related: `read-resource` reads non-class entries of the same artifact.
    - `MCP_HELP`: example `jarpeek mcp`; text: serves stdio MCP; `jarpeek init` wires it into harnesses.
    - `PRIME_HELP`: examples `jarpeek prime --full` and `jarpeek prime --export`; text: the full agent cheatsheet; `--export` bypasses a `.jarpeek/PRIME.md` override.
    - `INIT_HELP`: example `jarpeek init --yes`; text: non-interactive wiring (Claude Code + MCP).
  - The `command(name, description, helpText?)` helper in `src/cli/index.ts` calls `sub.addHelpText("after", helpText)` when the third argument is present; every `command(...)` call site passes its block. The program gets `program.addHelpText("after", TOP_LEVEL_HELP)`.

- [x] **Step 1: Write the failing tests**

Create `test/unit/cli-help.test.ts` with a unit `describe` (no spawn) asserting on the imported constants: `TOP_LEVEL_HELP` contains the exact frugal-path sentence, all five example lines, and the exact cheatsheet pointer line; each per-command block contains its example line(s) from the contract and a line starting `related:`. Then an integration `describe` with three `runCli` cases: (1) `["--help"]` → exit 0, stdout contains `the frugal path:` and `full agent cheatsheet: jarpeek prime --full`; (2) `["outline", "--help"]` → exit 0, stdout contains `Examples:` and `read-member`; (3) `["read-source", "--help"]` → exit 0, stdout contains `related:` and `outline`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-help.test.ts`
Expected: FAIL — cannot resolve `../src/cli/help.js`.

- [x] **Step 3: Write minimal implementation**

Create `src/cli/help.ts` with the constants per the contract above (a short file-header comment stating the block contract: blank-line-led, Examples + related, values auto-rendered by commander so never duplicated here). In `src/cli/index.ts`: extend the `command()` helper with the optional third parameter and its `addHelpText` call, pass each block at its call site, and add the top-level `addHelpText`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli-help.test.ts test/unit/cli-smoke.test.ts`
Expected: all PASS — including Task 2/3 cases (help additions must not disturb choice rendering or the unknown-command path).

- [x] **Step 5: Commit**

Run: `git add src/cli/help.ts src/cli/index.ts test/unit/cli-help.test.ts`
Run: `git commit -m "feat(cli): agent-grade help — frugal path, examples, related links"`

---

### Task 5: Verification sweep and spec coverage check

**Files:**
- No new files. Modifies nothing unless a check below exposes a gap.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a verified tree — full suite green, typecheck clean, every spec decision confirmed present, nothing outside the spec's scope changed.

- [x] **Step 1: Run the full quality gates**

Run: `npm test && npm run typecheck`
Expected: full suite PASS (unit + integration; e2e self-skips without `JARPEEK_E2E=1`), typecheck clean.

- [x] **Step 2: Manual smoke of the cold-agent path**

Run each and confirm against the spec's contract:
- `npx tsx src/cli/index.ts` → help on stdout, exit 0
- `npx tsx src/cli/index.ts --help` → ends with `full agent cheatsheet: jarpeek prime --full`
- `npx tsx src/cli/index.ts outline --help` → options show `(choices: …)` with all eleven kinds; block shows `Examples:` and `related:`
- `npx tsx src/cli/index.ts outline Foo --kind methods` → exit 1, `Allowed choices are …` naming every kind
- `npx tsx src/cli/index.ts find-classes Foo` → exit 1, `did you mean 'find-class'?`
- `npx tsx src/cli/index.ts mcp --help` → block present (the mcp command is registered via `registerMcpCommand`, not the `command()` helper — if its block is missing, wire `MCP_HELP` inside `src/cli/mcp-command.ts` with the same `addHelpText` call; that file is in scope for this step only)

- [x] **Step 3: Spec coverage check**

Walk the spec's locked decisions 1-7 (`docs/superpowers/specs/active/2026-08-19-agent-grade-help-design.md`) against the tree: D1 scope (no new commands, no heuristics — confirm nothing extra crept in), D2 choices, D3 shared enums, D4 help architecture (note: enum lists reach help via `choices()` auto-render, satisfying D4's no-drift intent without hand interpolation), D5 unknown command, D6 prime pointer, D7 miss protocol untouched (`test/unit/miss.test.ts` green). Fix any gap the same way its task would have.

- [x] **Step 4: Commit any residual fix (or nothing)**

Run: `git status` — expected clean tree after the previous tasks. If Step 2 or 3 produced a fix (e.g. the mcp-command wiring), commit it: `git commit -m "fix(cli): help coverage gap from verification sweep"`.

---

## Self-Review (performed after writing)

1. **Code scan** — no method bodies, algorithms, or test code; all content is contracts (exact strings the deliverable must produce, verified against commander 12.1.0 probes). ✓
2. **Self-containment** — every task repeats its full contracts (enum values, message formats, example lines); no "see Task N" dependencies for interfaces. ✓
3. **Spec coverage** — D1→Global Constraints, D2→Task 2, D3→Task 1, D4→Tasks 2+4 (auto-render note recorded), D5→Task 3, D6→Task 4, D7→Tasks 3/5. ✓
4. **Placeholder scan** — no TBD/TODO/vague handling; every test case names its input and exact expected output. ✓
5. **Type consistency** — `KIND_VALUES`/`VISIBILITY_VALUES` naming identical across tasks; `command(name, description, helpText?)` introduced and consumed in Task 4 only; constant names match between Produces and tests. ✓
