# Outline Skeleton + Separated Read-Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace `outline`'s clipped table with a Java-shaped skeleton (presets + section toggles, javadoc ladder, imports for source provenance, `--table` as legacy opt-in) and make `read-source` default to `full` uniformly on CLI and MCP.

**Architecture:** The parse layer stops discarding data it already holds (javadoc text, import statements, nested-class members); the core gains one preset/section resolver shared by CLI and MCP so the two surfaces cannot drift; a new pure renderer in `src/cli/skeleton.ts` turns filtered rows into indented code-shaped text with no clipping.

**Tech Stack:** TypeScript (strict), Node ≥ 20.12, commander 12 (negatable boolean pairs), zod (MCP schemas), vitest (offline unit + integration).

**Spec:** `docs/superpowers/specs/active/2026-08-18-outline-skeleton-design.md`

## Global Constraints

- `npm run typecheck` (tsc --noEmit) must stay clean; no new dependencies.
- Tests run offline against `test/fixtures` (never edit built jars — edit `test/fixtures/src` and run `node scripts/build-fixtures.mjs`).
- CLI integration tests execute the built CLI: run `npm run build` before `npm test`.
- stdout carries only the answer; stderr budget rules (≤3 lines) are untouched by this change.
- `--json` prints the exact core result object (CLI/MCP parity) — additive fields only, never renames.
- Commit messages use the repo's prefixes (`feat:`, `test:`, `docs:`, `chore:`).
- Version is bumped to `0.3.0` in BOTH `src/version.ts` and `package.json` (Task 8).

## File Structure

| File | Responsibility |
|---|---|
| `src/core/types.ts` | `Declaration.javadoc` field |
| `src/parse/declarations.ts` | `SourceFileDeclarations.imports` |
| `src/parse/java-lexer.ts`, `src/parse/kotlin-lexer.ts` | Capture javadoc text + import statements |
| `src/parse/records.ts` | Thread javadoc/imports through the parse seam |
| `src/core/query/locate.ts` | Full-family record retention, nested-row dedup, `LocatedClass.imports` |
| `src/core/query/outline.ts` | Preset/section resolver, data-level section filtering, `OutlineResult.imports` |
| `src/core/query/read-source.ts` | Default mode flips to `full` |
| `src/cli/skeleton.ts` (new) | Pure skeleton renderer + javadoc summarizer |
| `src/cli/index.ts` | CLI flags, wiring, read-source default |
| `src/mcp/server.ts` | `outline` preset/sections params, description text |
| `src/prime/content.ts`, `README.md`, `src/version.ts`, `package.json` | Docs, cheatsheet, version |
| `test/fixtures/src/java/com/example/Demo.java` | Gains an import statement (e2e coverage) |

---

### Task 1: Parse layer captures javadoc text and imports

**Files:**
- Modify: `src/core/types.ts` (Declaration, ~line 25)
- Modify: `src/parse/declarations.ts` (SourceFileDeclarations)
- Modify: `src/parse/java-lexer.ts` (import branch in `parseFile` ~line 260; javadoc spreads at lines 552, 568, 670, 714, 776, 832)
- Modify: `src/parse/kotlin-lexer.ts` (import handling; javadoc spreads at lines 783, 799, 1208, 1285, 1305, 1419)
- Modify: `src/parse/records.ts` (ClassRecordSource, classRecord, recordsFromSourceText)
- Modify: `test/fixtures/src/java/com/example/Demo.java` (add one import)
- Test: `test/unit/java-lexer.test.ts`, `test/unit/kotlin-lexer.test.ts`, `test/unit/records.test.ts`

**Interfaces:**
- Consumes: existing `JavadocInfo { start, end, line, text }` where `text` is the raw block INCLUDING `/**` and `*/` (verified: `java-lexer.ts:147-149`); existing `ParsedClass.members: Declaration[]`.
- Produces (later tasks rely on all of these):
  - `Declaration.javadoc?: string` — the raw doc block verbatim (`/** … */` / KDoc). Set by both lexers wherever `javadocStart` is set today; never set by classfile parsing.
  - `SourceFileDeclarations.imports: string[]` — verbatim import statements: `import java.net.URI;`, `import static java.util.Objects.requireNonNull;`, `import java.util.*;` (Java); `import a.b.C`, `import a.b.C as D` (Kotlin, no semicolon). Empty array when the file has none.
  - `recordsFromSourceText(text, file)` returns `{ records: Declaration[]; diagnostics: string[]; imports: string[] }` (new third field). Records now carry `javadoc`.
  - `classRecord` accepts and threads `javadoc?: string` via `ClassRecordSource`.

- [x] **Step 1: Write the failing tests**

In `test/unit/java-lexer.test.ts`: parsing a source with `package a.b; import java.net.URI; import static java.util.Objects.requireNonNull;` yields `imports` exactly `["import java.net.URI;", "import static java.util.Objects.requireNonNull;"]`; a class with javadoc, a method with javadoc, and a field with javadoc each produce records whose `javadoc` equals the raw block (e.g. `"/** Runs the demo. */"`). Non-javadoc members have no `javadoc` key (undefined). In `test/unit/kotlin-lexer.test.ts`: `import a.b.C as D` captured verbatim (no semicolon); KDoc text lands on class/member records. In `test/unit/records.test.ts`: `recordsFromSourceText` returns the file's imports and threads `javadoc` from a member declaration and from the class into the flat records.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/java-lexer.test.ts test/unit/kotlin-lexer.test.ts test/unit/records.test.ts`
Expected: FAIL — `imports` undefined / records lack `javadoc`.

- [x] **Step 3: Implement**

Add `javadoc?: string` to `Declaration`; add `imports: string[]` to `SourceFileDeclarations` (default `[]`). Java lexer: in `parseFile`'s import branch, reconstruct the statement from the consumed tokens (keyword `import`, optional `static`, dotted name, optional `.*`) joined with spaces and terminated by `;`; push to `result.imports`. Kotlin lexer: same for its import syntax (dotted name, optional ` as alias`, no semicolon). At every `header.javadoc ? { javadocStart: … }` spread site in both lexers, also spread `javadoc: header.javadoc.text`. In `records.ts`: extend `ClassRecordSource`/`classRecord` with `javadoc`; return `imports: parsed.imports` from `recordsFromSourceText`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/java-lexer.test.ts test/unit/kotlin-lexer.test.ts test/unit/records.test.ts`
Expected: PASS.

- [x] **Step 5: Fixture + golden repair**

Add `import java.util.List;` after the package line of `test/fixtures/src/java/com/example/Demo.java`, then run `node scripts/build-fixtures.mjs`. Existing golden tests that pin Demo.java line numbers shift by one — update those expectations (do not change assertions' meaning, only the pinned numbers). Run `npx vitest run test/unit` — Expected: PASS.

- [x] **Step 6: Commit**

Run: `git add -A && git commit -m "feat(parse): capture javadoc text and import statements"`

---

### Task 2: Locate keeps the full family, dedupes nested rows, carries imports

**Files:**
- Modify: `src/core/query/locate.ts` (`familyRecords` ~line 185, `binaryLocated` nested loop ~line 246, `sourceLocated` ~line 202, `LocatedClass` ~line 103)
- Test: `test/unit/locate.test.ts`, `test/integration/query-core.test.ts` (outline describe block)

**Interfaces:**
- Consumes: Task 1's `recordsFromSourceText` returns `{ records, diagnostics, imports }`; existing `classFamily(recordFqn, target)`, `isClassKind`.
- Produces:
  - `familyRecords(records, fqn, includeNested)` keeps: all records with `fqn === target` (any kind) AND, when `includeNested`, every record where `classFamily(record.fqn, fqn)` — nested-class **members included**, not just class rows.
  - Dedup rule (applies only when `includeNested`): outer class-kind member rows (`fqn === target && isClassKind`) whose `selector` equals the selector of a retained family class row (`fqn !== target && isClassKind && classFamily`) are dropped, so each nested class appears once.
  - `LocatedClass.imports?: string[]` — present for source backings (`sourceLocated` fills it from the parse result), absent for binary backings.
  - `includeNested: false` (the `resolveContent` path) behavior is unchanged: only `fqn === target` rows, no dedup, no imports change.

- [x] **Step 1: Write the failing tests**

In `test/unit/locate.test.ts`: (a) locating a source-backed class whose file declares a nested class returns the nested class's member rows too (nested member kind/method present, fqn = `outer.nested`); (b) each nested class contributes exactly ONE class-kind row (count of rows with a given nested selector and class kind === 1) — this is the RestTemplate duplication regression test; (c) `LocatedClass.imports` equals the fixture file's imports (`["import java.util.List;"]` for Demo) for a sources-jar winner and is `undefined` for a binary-only winner.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/locate.test.ts`
Expected: FAIL — nested members missing / duplicate class rows present / no `imports`.

- [x] **Step 3: Implement**

Relax `familyRecords` per the Produces contract; apply the dedup rule inside the same function (only in the `includeNested` branch). In `binaryLocated`'s nested-entry loop, keep every parsed record matching `classFamily` (drop the `isClassKind` restriction) so nested members from class bytes survive. In `sourceLocated`, thread `imports` from `recordsFromSourceText` into the returned `LocatedClass`; `binaryLocated` returns no `imports` key. `recordsForArtifact` is untouched.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/locate.test.ts test/integration/query-core.test.ts`
Expected: PASS (query-core outline scenarios now see nested members; if any pinned row counts there assumed class-kind-only retention, update them to the new contract — nested members are correct output now).

- [x] **Step 5: Commit**

Run: `git add -A && git commit -m "feat(locate): retain nested members, dedupe nested class rows, carry imports"`

---

### Task 3: Core outline — preset/section resolver and data-level filtering

**Files:**
- Modify: `src/core/query/outline.ts`
- Create: `test/unit/outline-sections.test.ts`
- Test: `test/integration/query-core.test.ts` (outline describe block)

**Interfaces:**
- Consumes: Task 2's `LocatedClass.imports` and full-family `records`.
- Produces (exact contracts used by Tasks 5–7):
  - `type OutlinePreset = "minimal" | "outline" | "full";`
  - `type SectionName = "imports" | "fields" | "methods" | "inner" | "javadoc";`
  - `type Sections = Record<SectionName, boolean>;`
  - `export function resolveSections(preset: OutlinePreset | undefined, overrides: Partial<Sections> | undefined): Sections` — pure. Preset maps: `minimal` → `{imports:false, fields:false, methods:true, inner:true, javadoc:false}`; `outline` and `undefined` → all five `true`; `full` → all five `true` (differs from `outline` only in CLI rendering, never in data). Any defined override field wins over the preset value.
  - `OutlineOptions` gains `preset?: OutlinePreset` and `sections?: Partial<Sections>` (alongside existing `kind`/`visibility`).
  - `outline(ctx, fqn, opts)` applies, in order: existing kind/visibility filter, then section filtering on the effective sections: `fields:false` drops rows with kind `field` | `property` | `enum-constant`; `methods:false` drops kind `method` | `constructor`; `inner:false` drops rows where `row.fqn !== fqn && classFamily(row.fqn, fqn)`; `javadoc:false` removes the `javadoc` property from every row. The target class's own row is never dropped by sections.
  - `OutlineResult.imports?: string[]` — present (the winner's imports) iff effective `sections.imports` is true AND the located winner carried imports; otherwise the key is absent.

- [x] **Step 1: Write the failing tests**

`test/unit/outline-sections.test.ts` (pure resolver tests, no ctx): every preset's five booleans per the table above; `undefined` preset ≡ `outline`; each single override flips only its field for every preset (e.g. `resolveSections("minimal", {imports: true})` → imports true, fields false); empty overrides ≡ no overrides. In `test/integration/query-core.test.ts`: outline on the Demo fixture returns `imports: ["import java.util.List;"]` by default; `sections: {fields: false}` result rows contain no field rows but keep the class row and methods; `sections: {inner: false}` drops every row whose fqn !== the queried fqn; `sections: {javadoc: false}` rows have no `javadoc` key; `preset: "minimal"` ≡ `{imports:true→absent imports field, fields:false, javadoc:false}` in one result; constructor rows survive `fields:false` and die under `methods:false`; enum-constant rows die under `fields:false` (use the `com.example.Colors` fixture).

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/outline-sections.test.ts test/integration/query-core.test.ts`
Expected: FAIL — `resolveSections` not exported / no `imports` in result.

- [x] **Step 3: Implement**

Add the types and `resolveSections` to `outline.ts`; extend `OutlineOptions`/`OutlineResult`; apply the filter chain and imports gating exactly as in Produces. Export `SectionName`, `Sections`, `OutlinePreset`, `resolveSections` for the CLI (Task 5) and tests.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/outline-sections.test.ts test/integration/query-core.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add -A && git commit -m "feat(outline): section presets, data-level filtering, imports in result"`

---

### Task 4: readSource defaults to full

**Files:**
- Modify: `src/core/query/read-source.ts` (`readSource`, ~line 166; header comment)
- Test: `test/integration/query-core.test.ts`, `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `readSource(ctx, fqn, {})` returns a `FullReadResult` (`mode: "full"`) — the default is `opts.mode ?? "full"`. Explicit `mode: "outline"` still returns the outline result; `mode: "lines"` still requires `from`/`to` (error unchanged). `resolveContent` untouched.

- [x] **Step 1: Write the failing tests**

`test/integration/query-core.test.ts`: `readSource(ctx, "com.example.Demo")` (no options) returns `mode === "full"` with the file's content and `lineCount`. In `cli.test.ts` update/replace the current "default mode renders the outline rows" test: `read-source com.example.Demo` with no flags now renders the full-source format (numbered lines, `file … provenance …` header) and its `--json` payload equals `readSource(ctx, fqn)` in-process.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/query-core.test.ts test/integration/cli.test.ts`
Expected: FAIL — default mode is still `outline`.

- [x] **Step 3: Implement**

Flip the default mode; update `read-source.ts`'s header comment (the doc paragraph currently narrates the outline default).

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/query-core.test.ts test/integration/cli.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add -A && git commit -m "feat(read-source): default mode is full source"`

---

### Task 5: The skeleton renderer

**Files:**
- Create: `src/cli/skeleton.ts`
- Create: `test/unit/skeleton.test.ts`

**Interfaces:**
- Consumes: `Declaration`, `Provenance` from `src/core/types.ts`; `Sections` from `src/core/query/outline.ts` (Task 3).
- Produces (used by Task 6):
  - `export function summarizeJavadoc(raw: string): string` — pure. Strips `/**`/`*/` and per-line leading `*` decorations, joins lines with single spaces, truncates at the first block tag (`@param`, `@return`, `@throws`, `@deprecated`, `@since`, … — any `@word` token), then takes the first sentence (up to and including the first `.`; whole remaining text when no period). Caps the result at 180 chars, appending `…` when cut. Returns `""` when nothing remains.
  - `interface SkeletonInput { fqn: string; coordinates: string; provenance: Provenance; stale?: boolean; rows: Declaration[]; imports?: string[] }` (structural subset of `OutlineResult`).
  - `export function renderSkeleton(input: SkeletonInput, sections: Sections, detail: "summary" | "full"): string` — pure, no I/O, **never truncates any line**.
  - Layout contract, in order: comment header `// <fqn>` then `// <coordinates>  provenance <provenance>` then (when `stale`) `// stale index served`; blank line; `package <fqn minus last segment>;` (omitted when the fqn has no dot); import statements verbatim one per line when `input.imports` is present (the core already gated them on `sections.imports`); blank line; the class body.
  - Body contract: rows group by declaring fqn into a tree — the target class's own class-kind row (fqn === input.fqn) is the root; rows with `fqn === input.fqn` are its members in row order; a row whose fqn is `input.fqn` + "." + one-or-more segments forms a nested class node (deeper segment counts nest deeper), rendered where its class row first appears. Nested node: class signature + ` {`, contents indented 4 spaces per level (members, then child nodes, first-occurrence order), closing `}`. Outer class-kind member rows that duplicate a nested class row were already dropped upstream (Task 2) — the renderer simply never renders a class-kind member row as a plain line; it renders nodes.
  - Member lines: `signature;`. In `detail: "full"`, method and constructor lines end ` { … }` instead of `;` (fields keep `;`).
  - Javadoc lines (when `sections.javadoc` and the row carries `javadoc`): `detail: "summary"` → one line `/** <summarizeJavadoc(raw)> */` above the member at the same indent, omitted when the summary is `""`; `detail: "full"` → the raw block's lines above the member, each indented. Class rows (root and nested) get the same treatment.
  - Graceful empties: all sections off still renders header + package + class signature + `{`/`}`; no members → empty braces on separate lines.

- [x] **Step 1: Write the failing tests**

`test/unit/skeleton.test.ts` with hand-built rows (no fixtures): (1) header comments exactly `// a.b.Demo` / `// g:a:1  provenance source` (+ stale line when flagged); (2) `package a.b;` derived from the fqn, omitted for a dotless fqn; (3) imports render verbatim and are skipped when `imports` is absent; (4) members render as `signature;` in row order, indented 4 spaces; (5) a nested class node renders `signature {`, its members at 8 spaces, `}` — and a doubly nested class reaches 12; (6) javadoc summary line sits above its member, drops `@param`/`@return` text, ends at the first sentence, caps at 180 chars with `…`; (7) `detail: "full"` renders the raw block lines and method lines end ` { … }`; (8) a 200-char signature appears verbatim (no-clipping assertion); (9) `sections.javadoc: false` renders no javadoc even when rows carry it; (10) summarizeJavadoc edge cases: inline `{@link …}` kept as plain text, no period → whole text, empty description → `""`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/skeleton.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

Write `src/cli/skeleton.ts` exactly to the Produces contract. Dependency-free (matches `render.ts`'s ethos); the javadoc block `//`-header style comes from the input object, not from environment.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/skeleton.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add src/cli/skeleton.ts test/unit/skeleton.test.ts && git commit -m "feat(cli): java-shaped skeleton renderer"`

---

### Task 6: CLI wiring — outline flags, skeleton default, read-source default

**Files:**
- Modify: `src/cli/index.ts` (outline command ~line 352, read-source command ~line 394, `renderReadSource` ~line 175)
- Test: `test/integration/cli.test.ts` (outline + read-source describe blocks)

**Interfaces:**
- Consumes: Task 3's `resolveSections`/`Sections`/`OutlinePreset`, Task 5's `renderSkeleton`/`SkeletonInput`, Task 4's full default.
- Produces:
  - `outline` flags: existing `--kind`/`--visibility`; `--minimal` and `--full` (mutually exclusive — passing both throws `InvalidArgumentError`); five negatable pairs `--imports/--no-imports`, `--fields/--no-fields`, `--methods/--no-methods`, `--inner/--no-inner`, `--javadoc/--no-javadoc` (commander 12: declaring both options yields true / false / undefined-absent — verified against the installed version); `--table`.
  - Mapping: `preset := --minimal ? "minimal" : --full ? "full" : "outline"`; each toggle dest !== undefined becomes a `sections` override. Core call: `outline(ctx, fqn, { kind?, visibility?, preset, sections? })`. Human render: `--table` → the existing `renderOutlineRows` block verbatim; otherwise `renderSkeleton(result, resolveSections(preset, sections), preset === "full" ? "full" : "summary")`. `--json` output unchanged in mechanics (prints the core result).
  - `read-source`: `--full` retained as explicit form, `--lines a:b` unchanged, exclusivity error unchanged; the no-flag default now exercises Task 4's core default (no mode passed).
  - `renderReadSource`'s `mode === "outline"` branch renders via `renderSkeleton(…, "summary")` instead of the table (branch is unreachable from CLI flags after this task — defensive consistency only).

- [x] **Step 1: Write the failing tests**

In `cli.test.ts` outline block (rewrite existing table assertions): (1) `outline com.example.Demo` renders `// com.example.Demo` header, `package com.example;`, `import java.util.List;`, `public class Demo {`, members as `signature;` lines, closing `}`; (2) `--kind method` output contains only method/constructor member lines; (3) `--minimal` output has no `import` lines and no field lines but keeps methods; (4) `--minimal --fields` re-enables field lines (toggle-over-preset); (5) `--full` method lines end ` { … }` and javadoc blocks render whole; (6) `--no-javadoc` suppresses javadoc lines; (7) `--table` renders the legacy header row `SELECTOR  KIND  VIS …`; (8) `--minimal --full` exits 1 with the mutual-exclusion error; (9) `--json outline … --kind method` still deep-equals the in-process `outline(ctx, fqn, {kind})` result, and `--json outline … --minimal --no-javadoc` deep-equals the in-process `outline(ctx, fqn, { preset: "minimal", sections: { javadoc: false } })` result — CLI flags and MCP params provably reach the identical core sections (the spec's parity test). In the read-source block: no-flag run renders numbered full source (Task 4 already added this — keep both green).

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx vitest run test/integration/cli.test.ts`
Expected: FAIL — outline still renders the table; `--minimal` unknown option.

- [x] **Step 3: Implement**

Wire the flags per Produces. Update the outline command's commander description string (`"java-shaped class skeleton (presets + section toggles; --table for the legacy view)"`). Keep `warn(…result.degraded)` and the miss path untouched.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/integration/cli.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add -A && git commit -m "feat(cli): outline skeleton default with presets, toggles, --table"`

---

### Task 7: MCP mirrors the CLI

**Files:**
- Modify: `src/mcp/server.ts` (outline tool ~line 133, read_source ~line 164, server instructions ~line 117)
- Test: `test/integration/mcp.test.ts`

**Interfaces:**
- Consumes: Task 3's `OutlineOptions` (`preset`, `sections`), Task 4's full default.
- Produces:
  - `outline` inputSchema adds: `preset: z.enum(["minimal", "outline", "full"]).optional()` and `sections: z.object({ imports: z.boolean().optional(), fields: z.boolean().optional(), methods: z.boolean().optional(), inner: z.boolean().optional(), javadoc: z.boolean().optional() }).optional()`, passed through to `outline(ctx, fqn, …)` alongside `kind`/`visibility`.
  - `read_source` schema unchanged; its description becomes `"Source text for one class (full | lines | outline) — default full; prefer outline for the frugal first look."` The server `instructions` string gains the same frugality steer (outline/read_member before read_source).
  - Default parity is inherited from the core (Task 4) — no per-surface default exists anywhere.

- [x] **Step 1: Write the failing tests**

In `mcp.test.ts`: (1) calling the `outline` tool with `preset: "minimal"` returns the same payload as in-process `outline(ctx, fqn, { preset: "minimal" })`; (2) `sections: { fields: false, javadoc: false }` deep-equals the matching in-process call; (3) `read_source` with no `mode` returns `mode === "full"`; (4) `read_source` with `mode: "outline"` still returns the outline-shaped payload.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/mcp.test.ts`
Expected: FAIL — schema rejects `preset`/`sections`; default mode outline.

- [x] **Step 3: Implement**

Extend the two registrations per Produces; update the two description strings.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/mcp.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add -A && git commit -m "feat(mcp): outline preset/sections params, read_source defaults full"`

---

### Task 8: Cheatsheet, README, version 0.3.0

**Files:**
- Modify: `src/prime/content.ts` (CLI_CONTENT commands table rows for outline and read-source; MCP card unchanged in tool list)
- Modify: `README.md` (Why bullet "Outline first" ~line 32; MCP tools table rows outline/read_source ~lines 82-84; CLI examples ~line 118; Provenance section — imports/javadoc are source-only)
- Modify: `src/version.ts`, `package.json` (both → `0.3.0`)
- Test: `test/unit/prime.test.ts`, `test/integration/packaging.test.ts`

**Interfaces:**
- Consumes: final flag surface from Tasks 6–7.
- Produces: docs that describe the shipped behavior only. Cheatsheet outline row: `outline <fqn> [--kind k] [--visibility v] [--minimal|--full] [--no-imports] [--no-fields] [--no-methods] [--no-inner] [--no-javadoc] [--table]` → "java-shaped class skeleton". Cheatsheet read-source row: whole file by default; `--lines a:b` for a range; and one sentence stating outline/read-member are the frugal entry points before reading whole files. README changes per Files. Version `0.3.0` in both version files (a mismatch fails packaging tests).

- [x] **Step 1: Write the failing tests**

`prime.test.ts`: the CLI cheatsheet contains `--minimal` and states read-source returns the whole file by default; it no longer contains the phrase "outline by default". `packaging.test.ts` (or a new assertion there): `VERSION` equals `package.json` version and both are `"0.3.0"`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/prime.test.ts test/integration/packaging.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

Apply the content edits per Produces. Keep the 600–1200-word budget of CLI_CONTENT roughly stable (net-new wording replaces the old rows).

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/prime.test.ts test/integration/packaging.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add -A && git commit -m "docs: skeleton outline + full-default read-source; 0.3.0"`

---

### Task 9: Full verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: green suite evidence.

- [x] **Step 1: Rebuild everything offline**

Run: `node scripts/build-fixtures.mjs && npm run build`
Expected: both succeed.

- [x] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: 0 type errors; all unit + integration tests PASS (e2e self-skip without `JARPEEK_E2E=1`).

- [x] **Step 3: Smoke the real UX**

Run the built CLI against the fixture project (the directory `cli.test.ts` builds its `c` fixture from — mirror its setup): `node dist/cli/index.js outline com.example.Demo`, then with `--minimal`, `--full`, `--table`. Expected: skeleton renders as designed; `--table` shows the legacy table; no stderr noise.

- [x] **Step 4: Close out**

Run: `git status` (expect clean tree). Update beads: `bd close jvm-src-dvv` with the spec/plan paths in the reason.
