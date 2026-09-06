# CLI Russian Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Human-mode CLI output (help, renderers, errors, warnings) renders in Russian when selected via `--lang ru` or `.jarpeek/config.json` `"language": "ru"`, through an extensible typed-catalog i18n layer.

**Architecture:** New `src/cli/i18n/` module: flat English catalog as source of truth, `type Catalog = typeof en`, Russian catalog compiler-forced to full coverage. `resolveLocale` converges flag > config > `en` (mirroring `primeMode`/`buildTool` patterns). A raw-argv pre-scan feeds build-time strings (commander descriptions/help) because commander constructs the program before parsing; runtime actions re-resolve through parsed options.

**Tech Stack:** TypeScript (ESM), commander 12, vitest, Node built-in `Intl.PluralRules`. Zero new dependencies.

## Global Constraints

- Localize **human-mode output only**. Never change: `--json` output (`renderJson` and result objects), MCP server strings, `prime` cheatsheet content, and any string **produced by core/resolver** (degraded warnings, miss `note`, `reason` fields, resolver reasons) — those are machine/agent contract surface.
- Schema-shaped tokens stay verbatim in both locales: command/flag names, FQNs, coordinates, paths, table column headers (FQN, KIND, ARTIFACT, PROVENANCE, SELECTOR, VIS, STATIC, DEP, SIGNATURE, PATH, SIZE, CONTENT, KEY, VALUE), enum-ish cell values (`method`, `static`, `dep`, provenance values, where-roles), `renderStatus` output entirely, the `[jarpeek]` stderr prefix, and the literal `jarpeek status` / `jarpeek --help` command references inside messages.
- Locale chain: `--lang` flag > `.jarpeek/config.json` `language` field > `"en"`. Absent/corrupt/invalid config values fall through to the next layer. An invalid **flag** value is rejected by commander `choices` (exit 1, standard commander error text — not localized).
- Catalog typing: `ru.ts` must import `type Catalog` from `en.ts` (`type Catalog = typeof en`); every key added to `en` is added to `ru` in the same task. No runtime fallback machinery — the compiler is the completeness check.
- Russian copy: this plan's "Canonical Russian" tables are the required copy for pinned phrases; for the rest, the implementer composes Russian following the same register (informal-but-technical, «ё» avoided in UI copy is NOT required — use natural Russian with «ё»).
- Commands: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit). Targeted: `npx vitest run <file>`.
- Spawn pattern for CLI tests: `process.execPath` + `["--import", "tsx", "src/cli/index.ts", ...args]` with `cwd` = PKG_ROOT (bare tsx only resolves from PKG_ROOT; never `npx`/`.bin` shims — they are `.cmd` on win32).
- Default (no `--lang`, no config) output must remain byte-identical to today; the untouched existing tests are the oracle.

---

### Task 1: i18n core module — types, `t`, `choose`, `resolveLocale`

**Files:**
- Create: `src/cli/i18n/en.ts`
- Create: `src/cli/i18n/ru.ts`
- Create: `src/cli/i18n/index.ts`
- Test: `test/unit/i18n.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `type Locale = "en" | "ru"` and `const LOCALE_VALUES: readonly Locale[]` = `["en", "ru"]` (both exported from `src/cli/i18n/index.ts`).
  - `en.ts`: `export const en = { … } as const` — the flat message catalog; keys are dot-namespaced (`"cli.description"`, `"warn.first"`, …). Starts with **no keys** in this task (later tasks add keys); `export type Catalog = typeof en`.
  - `ru.ts`: `export const ru: Catalog = { … }` — empty here, grows with `en`.
  - `index.ts` re-exports `en`, `ru`, `Catalog`, and provides:
    - `catalog(locale: Locale): Catalog` — `"en"` → `en`, `"ru"` → `ru`.
    - `t(template: string, params?: Record<string, string | number>): string` — replaces every `{name}` token in `template` whose name is a key of `params`; unreferenced params ignored; tokens without a param stay literal.
    - `choose(locale: Locale, count: number, forms: Record<string, string>): string` — `new Intl.PluralRules(locale).select(count)` category → `forms[category]`; falls back to `forms.other` when the category is absent.
    - `resolveLocale(input: { flag?: string; projectRoot: string }): Locale` — `input.flag` when it is exactly `"en"` or `"ru"`; else the `language` field of `<projectRoot>/.jarpeek/config.json` when it is exactly `"en"` or `"ru"`; else `"en"`. Absent file, unreadable file, invalid JSON, or an invalid `language` value all fall through to `"en"`. An invalid `flag` value is treated as absent (commander still rejects it at parse time with its own error).
    - `preScan(argv: string[]): { lang?: string; project?: string }` — scans the raw argv (already stripped of `node`/script) left to right, stopping at a bare `--`; recognizes `--lang <v>`, `--lang=<v>`, `--project <dir>`, `--project=<dir>`; later occurrences overwrite earlier ones; anything else is skipped.

- [ ] **Step 1: Write the failing tests**

New `test/unit/i18n.test.ts`, plain unit imports (the i18n module has no side effects). Scenarios:

1. `resolveLocale` — flag wins: `{ flag: "ru", projectRoot: <dir with config language:"en"> }` → `"ru"`.
2. `resolveLocale` — config: no flag, dir with `.jarpeek/config.json` `{"language":"ru"}` → `"ru"`.
3. `resolveLocale` — default: no flag, empty tmp dir → `"en"`.
4. `resolveLocale` — corrupt JSON file → `"en"`; config `{"language":"de"}` → `"en"`; config `{"language": 3}` → `"en"`.
5. `resolveLocale` — invalid flag `"xx"` with config `"ru"` → `"ru"` (flag treated as absent).
6. `t` — `t("{n} artifacts in {ms}ms", { n: 3, ms: 12 })` → `"3 artifacts in 12ms"`; `t("plain")` → `"plain"`; token without param (`t("{x}")`) → `"{x}"`.
7. `choose` ru categories: 1 → `one`, 2 → `few`, 5 → `many`, 11 → `many`, 21 → `one`, 22 → `few`, 25 → `many` (forms object with distinct values per category; assert the selected one).
8. `choose` en: 1 → `one`, 0 → `other`, 2 → `other`.
9. `choose` fallback: ru forms missing `few` → returns `other`.
10. `preScan`: `["--lang", "ru"]`, `["--lang=ru"]`, `["find-class", "X", "--lang", "ru"]` all yield `lang: "ru"`; `["--project", "/a", "--lang", "ru"]` yields both; `["--", "--lang", "ru"]` yields nothing; `["--limit", "5"]` yields nothing; later occurrence wins: `["--lang", "en", "--lang", "ru"]` → `"ru"`.
11. `catalog`: `catalog("en") === en`, `catalog("ru") === ru`; `LOCALE_VALUES` equals `["en", "ru"]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/i18n.test.ts`
Expected: FAIL — module `src/cli/i18n/index.js` cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

Create the three files per the Interfaces block. `en.ts` holds only the type + empty const this task. Config read uses `node:fs` `readFileSync` inside a try/catch (the `primeMode`/`buildTool` fall-through pattern). Do not import anything from `src/prime/` or `src/resolver/` — keep the i18n module dependency-free except `node:*`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/i18n.test.ts`
Expected: PASS (all scenarios).

- [ ] **Step 5: Commit**

Run: `git add src/cli/i18n test/unit/i18n.test.ts`
Run: `git commit -m "feat(i18n): locale types, t/choose helpers, flag>config>en convergence"`

---

### Task 2: `--lang` flag, pre-scan wiring, and the build-time surface (descriptions + help blocks)

**Files:**
- Modify: `src/cli/help.ts` (all 13 exported constants become functions of the catalog)
- Modify: `src/cli/index.ts` (pre-scan wiring, `--lang` global option, descriptions, option help strings)
- Modify: `src/cli/mcp-command.ts` (description string via catalog)
- Modify: `test/unit/cli-help.test.ts` (constants → function calls; add ru assertions)
- Test: `test/unit/cli-help.test.ts` (extended)

**Interfaces:**
- Consumes: `Locale`, `LOCALE_VALUES`, `catalog`, `t`, `resolveLocale`, `preScan` from Task 1.
- Produces:
  - `src/cli/i18n/en.ts` gains the build-time keys; `ru.ts` gains the same keys translated. Key set (dot-namespaced; exact ids are the implementer's choice, one key per string): program description; `--json`, `--project`, `--build-tool`, `--lang` option descriptions; every subcommand one-line description (find-class, outline, read-member, read-source, read-resource, search-symbols, resolve, status, where, mcp, prime, init); every per-command option description (`--limit`, `--kind`, `--visibility`, `--minimal`, `--full`, `--imports`/`--no-imports` and the four sibling toggle pairs, `--table`, `--lines`, `--artifact`, `--yes`, `--export`, `--hook-json`, `--mcp`); help-block prose: the frugal-path sentence, the `Examples:` section label, the `related:` label, the prime pointer line (`full agent cheatsheet: …`), the MCP explanatory line, the PRIME explanatory line, the INIT explanatory line, the OUTLINE `--table` related clause.
  - `src/cli/help.ts`: each exported `X_HELP` const becomes `export function xHelp(t: Catalog): string` (camelCase: `topLevelHelp`, `findClassHelp`, `outlineHelp`, `readMemberHelp`, `readSourceHelp`, `readResourceHelp`, `searchSymbolsHelp`, `resolveHelp`, `statusHelp`, `whereHelp`, `mcpHelp`, `primeHelp`, `initHelp`). Example command lines inside blocks stay literal (untranslated); only labels/prose come from the catalog.
  - `src/cli/index.ts`: module top computes `const scanned = preScan(process.argv.slice(2))` and `const buildLocale = resolveLocale({ flag: scanned.lang, projectRoot: scanned.project ?? process.cwd() })` **before** `new Command()`; all `.description()`/`.option()`/`.addHelpText()` strings come from `catalog(buildLocale)`. The program gains the sticky global option `--lang <locale>` with `choices([...LOCALE_VALUES])` (commander rejects invalid values itself).
  - `GlobalOptions` in index.ts gains `lang?: string` (consumed fully in Task 3).
- Canonical Russian (pinned copy for tests): `Examples:` → `Примеры:`; `related:` → `связанное:`; frugal-path sentence → `экономный путь: find-class находит класс, outline показывает его устройство, read-member даёт код конкретного члена — read-source нужен только для файла целиком.`; prime pointer → `полная шпаргалка для агентов: jarpeek prime --full`; program description → `доступ к исходникам зависимостей для AI-агентов в JVM-проектах`.

- [ ] **Step 1: Write the failing tests**

Rework `test/unit/cli-help.test.ts`:

1. Import the 13 help functions; every existing assertion re-targets the function called with `catalog("en")` — all current pinned strings must still hold byte-for-byte (en is the regression oracle).
2. New unit case: each help function called with `catalog("ru")` contains its example lines verbatim (e.g. `jarpeek find-class StringJoiner --limit 5`), contains `Примеры:`, and the query blocks match `/^связанное:/m`.
3. New spawn cases (reuse the file's `runCli` helper, cwd PKG_ROOT):
   - `["--lang", "ru", "--help"]` → exit 0; stdout contains the ru program description, `экономный путь:`, `Примеры:`, `полная шпаргалка`; stdout does **not** contain `the frugal path:`; still contains `--lang` and `--build-tool` flag rows and `find-class StringJoiner --limit 5`.
   - `["--help"]` → unchanged en output (contains `the frugal path:` — the existing assertions already pin this).
   - `["--lang", "ru", "outline", "--help"]` → ru outline description present, `Примеры:` present, example line `jarpeek outline java.util.StringJoiner --kind method` present.
   - `["--lang", "fr", "--help"]` → exit 1 (commander choices rejection).
   - Config at build time: tmp dir with `.jarpeek/config.json` `{"language":"ru"}`; `["--project", "<tmp>", "--help"]` → ru help without any `--lang` flag.
   - `["--lang", "en", "--help"]` with ru config in `<tmp>` → en help (flag beats config).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-help.test.ts`
Expected: FAIL — help.ts still exports constants; `--lang` unknown option.

- [ ] **Step 3: Write minimal implementation**

Convert help.ts to functions; wire the pre-scan + `buildLocale` in index.ts; localize descriptions/option strings/`.addHelpText` callbacks (`(context) => …` evaluated at render time but closing over `buildLocale`'s catalog is fine — same locale); add the `--lang` option; add all keys to `en.ts` and their translations to `ru.ts`. `mcp-command.ts`'s `registerMcpCommand` receives the build-time catalog (add a `t: Catalog` parameter; index.ts passes it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli-help.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (ru covers en exactly).

- [ ] **Step 5: Commit**

Run: `git add src/cli test/unit/cli-help.test.ts`
Run: `git commit -m "feat(i18n): --lang flag + pre-scan; ru help and command descriptions"`

---

### Task 3: Runtime locale — Invocation plumbing, stderr channel, miss rendering, usage errors

**Files:**
- Modify: `src/cli/index.ts` (`Invocation`, `invocation()`, `warn`, `emitMiss`, flag parsers, unknown-command action, fatal handler)
- Modify: `src/cli/i18n/en.ts`, `src/cli/i18n/ru.ts` (new keys)
- Test: `test/integration/cli-lang.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1 helpers; Task 2's `GlobalOptions.lang`.
- Produces:
  - `Invocation` gains `locale: Locale`; `invocation()` sets it via `resolveLocale({ flag: opts.lang, projectRoot: opts.project ?? process.cwd() })`.
  - Localized runtime strings (new catalog keys, en text = today's literals): `warning: ` prefix; the aggregate warn line `warning: +{n} more (see: jarpeek status)` (ru via `choose`); `no indexed class for {label}; did you mean:`; `searched:`; `(none)`; `--lines` errors (both messages, value interpolated); the positive-int error; `--minimal and --full are mutually exclusive`; `--full and --lines are mutually exclusive`; unknown-command template `unknown command '{name}' — did you mean '{suggestion}'? (see: jarpeek --help)` and its no-suggestion variant; the fatal `error: ` prefix (generic branch only — `SelectorError`/`InvalidArgumentError` print bare messages, unchanged).
  - Coercion hooks (`parseLinesFlag`, `parsePositiveInt`) run at parse time: they use the module-level `buildLocale` catalog. Stated edge (accepted): with a *trailing* `--lang ru`, a coercion error renders in the pre-scan locale.
- Canonical Russian (pinned for tests): `warning: ` → `предупреждение: `; aggregate → `предупреждение: ещё {n} {plural(предупреждение/предупреждения/предупреждений)} (см. jarpeek status)`; did-you-mean → `нет индексированного класса для {label}; возможно, вы имели в виду:`; `searched:` → `просмотрено:`; `(none)` → `(нет)`; unknown command → `неизвестная команда '{name}' — возможно, вы имели в виду '{suggestion}'? (см. jarpeek --help)`; `error: ` → `ошибка: `.

- [ ] **Step 1: Write the failing tests**

New `test/integration/cli-lang.test.ts` following `test/integration/cli.test.ts`'s suite pattern: tmp project + in-process `openContext` bootstrap with the same three fixture artifacts (`demo-lib` sources-backed, `demo-lib-bin`, `nosources-lib`), `process.env.JARPEEK_BUILD_TOOL = "wrapper"`, spawn via `process.execPath` + `["--import","tsx","src/cli/index.ts","--project",root,…]` from PKG_ROOT. Scenarios:

1. Miss with suggestions: `["--lang","ru","find-class","StringJoinerX"]` (a query that fuzzy-matches `StringJoiner`) → stdout contains `возможно, вы имели в виду:` and not `did you mean:`.
2. Negative miss on the empty project (a second suite whose resolver returns null): stdout contains `просмотрено:`; with zero artifacts, contains `(нет)`.
3. Degraded warning channel: a suite whose resolver reports a degradation (the cli.test.ts pattern for degraded entries) → stderr starts `предупреждение: `; two distinct degradations → second line matches `ещё 1` and `(см. jarpeek status)`.
4. Usage error: `["--lang","ru","read-source","com.example.lib.ApiClient","--lines","bad"]` → exit 1, stderr contains the ru `--lines` message, not `expects from:to`.
5. Mutual exclusion: `["--lang","ru","outline","X","--minimal","--full"]` → exit 1, ru message.
6. Unknown command: `["--lang","ru","fint-class"]` → exit 1, stderr matches `неизвестная команда 'fint-class'` and `find-class` suggestion.
7. Trailing flag works at runtime: `["find-class","StringJoiner","--lang","ru"]` against the bootstrapped project → any CLI-composed prose on stdout/stderr is ru (hits table itself is verbatim tokens).
8. En default regression: the same invocations without `--lang` still emit the exact en strings (assert `did you mean:` / `warning: ` where applicable).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/cli-lang.test.ts`
Expected: FAIL — en strings emitted under `--lang ru`.

- [ ] **Step 3: Write minimal implementation**

Thread `locale` through `Invocation`; localize `warn` (prefix + aggregate with `choose`), `emitMiss`, the three parser-error sites (coercion hooks read `buildLocale`; action-time mutual-exclusion checks read `inv.locale`), the unknown-command template, and the generic fatal prefix. Add keys to both catalogs. Core-produced strings (`miss.note`, `miss.reason`, resolver degradation texts) pass through untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/cli-lang.test.ts test/integration/output-budget.test.ts test/integration/warning-channel.test.ts`
Expected: PASS — including the untouched budget/channel suites (en default unchanged).

- [ ] **Step 5: Commit**

Run: `git add src/cli test/integration/cli-lang.test.ts`
Run: `git commit -m "feat(i18n): ru runtime channel — warnings, misses, usage errors"`

---

### Task 4: Human result renderers

**Files:**
- Modify: `src/cli/index.ts` (`renderMember`, `renderReadMember`, `renderReadSource`, `renderReadResource`, `renderSearchSymbols` empty case, `renderResolve`, `renderWhere`, `renderInit` — and their call sites inside `.action()` bodies)
- Modify: `src/cli/i18n/en.ts`, `src/cli/i18n/ru.ts`
- Test: `test/integration/cli-lang.test.ts` (extend)

**Interfaces:**
- Consumes: `Invocation.locale` (Task 3); `t`, `choose`, `catalog` (Task 1).
- Produces: renderer functions take the invocation's catalog (parameter or closure at call site) and compose: `lines {a}–{b}`; `signature only`; `miss {selector}: ` label (reason value stays en); `alternative: {coords}`; `file {f} provenance {p}`; `lines {a}-{b} of {c}` and its ` (clamped)` suffix; `artifact {a} provenance {p}`; `no matching entries (provenance {p})`; `no symbols found for {q}`; `resolved {n} artifacts in {ms}ms` + ` ({w} warnings)` suffix; `+{n} more (see: jarpeek status)`; `coordinates {c}`; `(exists)` / `(missing)`; `build systems: `; `(none)` / `(not detected)`; `wired {harness} ({mode}): `; `note: `. Renderers that are all-tokens (`renderFindClassRows`, `renderOutlineRows`, the read-resource/search-symbols tables, `renderStatus`) gain **no** catalog parameter — they are unchanged.
- Canonical Russian (pinned for tests): `lines 3–9` → `строки 3–9`; `signature only` → `только сигнатура`; `miss` label → `не найдено`; `alternative:` → `альтернатива:`; `file {f} provenance {p}` → `файл {f}, происхождение {p}`; `of {c}` form → `строки {a}–{b} из {c}`; `(clamped)` → `(усечено)`; `artifact …` → `артефакт {a}, происхождение {p}`; no entries → `нет подходящих записей`; no symbols → `символы по запросу {q} не найдены`; resolved line → `разрешен {n} артефакт / разрешено {n} артефакта / разрешено {n} артефактов` (choose on n) + ` за {ms} мс` + ` ({w} предупреждений…)` (choose on w); more-line → `+{n} … (см. jarpeek status)`; `coordinates` → `координаты`; `(exists)`/`(missing)` → `(существует)`/`(отсутствует)`; `build systems:` → `системы сборки:`; `(none)` → `(нет)`; `(not detected)` → `(не найден)`; `wired` → `настроено`; `note:` → `примечание:`. `jdk:` label stays verbatim (proper noun).

- [ ] **Step 1: Write the failing tests**

Extend `test/integration/cli-lang.test.ts` (same suites):

1. `["--lang","ru","read-member","com.example.lib.ApiClient","#toString()"]` (a selector the fixture answers; pick one cli.test.ts already asserts) → stdout contains `строки` and `происхождение`; not `lines ` header nor `provenance `.
2. `["--lang","ru","read-member",<fqn>,"#nosuch()"]` → the `не найдено` label with the en reason text after it.
3. `["--lang","ru","read-source",<fqn>,"--lines","2:3"]` → `строки 2–3 из` present; `--full` variant → `строки 1-` prefix per full-mode header shape.
4. `["--lang","ru","read-resource","com.example:demo-lib:1.0.0","META-INF/**"]` → `артефакт` and `происхождение`; a no-match glob → `нет подходящих записей`.
5. `["--lang","ru","search-symbols","nosuchsymbol","--artifact","com.example:demo-lib:1.0.0"]` → `символы по запросу` phrase.
6. `["--lang","ru","resolve"]` against the fake-`gradlew` project (cli.test.ts's resolve suite pattern) → `разрешено 3 артефакта` (3 fixtures → ru `few`) and `за` … `мс`; a warnings-carrying resolve → `предупрежд` suffix form.
7. `["--lang","ru","where","com.example:demo-lib:1.0.0"]` → `координаты`, `(существует)`.
8. `["--lang","ru","init","--yes"]` on a tmp root → `системы сборки:` and `примечание:` or `настроено` lines as applicable.
9. En regression: the cli.test.ts suite already pins every en renderer string; no changes there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/cli-lang.test.ts`
Expected: FAIL — new cases emit en.

- [ ] **Step 3: Write minimal implementation**

Add the catalog keys to both files; thread the catalog into the eight renderers and their call sites; counts go through `choose`. Keep column-header tables byte-identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/cli-lang.test.ts test/integration/cli.test.ts && npm run typecheck`
Expected: PASS everywhere; en output unchanged.

- [ ] **Step 5: Commit**

Run: `git add src/cli test/integration/cli-lang.test.ts`
Run: `git commit -m "feat(i18n): ru human renderers — members, source, resources, resolve, where, init"`

---

### Task 5: Docs + full regression sweep

**Files:**
- Modify: `README.md` (configuration section)
- Modify: `docs/design.md` (decision log)

**Interfaces:**
- Consumes: the finished feature.
- Produces: README gains a **Language** row/paragraph in the configuration area: `--lang <en|ru>` flag, `.jarpeek/config.json` `"language"` field, precedence flag > config > default English, scope note (human output only; `--json`/MCP/prime always English). `docs/design.md` gains a short decision-log entry: the human-mode-only boundary, the CLI-layer/core-layer string split (with the token-verbatim rule), the typed-catalog mechanism, and the pre-scan reason (commander builds before parsing).

- [ ] **Step 1: Write the docs**

Apply the two doc edits above, matching each file's existing tone and detailization level (README overview-level; design.md decision-log depth).

- [ ] **Step 2: Full regression**

Run: `npm test && npm run typecheck`
Expected: entire suite PASS, typecheck clean — proving default output byte-stability and ru coverage.

- [ ] **Step 3: Commit**

Run: `git add README.md docs/design.md`
Run: `git commit -m "docs: --lang ru and the language config field"`

---

## Self-Review notes

- Spec coverage: decisions 1–5 → Global Constraints + Tasks 1–4; docs section → Task 5; testing section → Tasks 1–5 test steps. `renderStatus` deliberately gains no catalog parameter (spec's verbatim rule for its whole output overrides its earlier "gains a catalog parameter" line); the spec's render.ts bullet was corrected to match.
- No code in any step; every test names its scenario and expected result; canonical ru copy supplied as design content.
- Type consistency: `Locale`/`Catalog`/`catalog`/`t`/`choose`/`resolveLocale`/`preScan` names used identically across tasks.
