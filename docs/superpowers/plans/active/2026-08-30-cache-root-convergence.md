# Cache-Root Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make jarpeek follow Maven wherever the local repository actually lives (GH#12) and give cache roots a full customization surface: env vars, project + global config files, `settings.xml`, and an init step.

**Architecture:** One new convergence module (`src/resolver/roots.ts`) computes ordered m2 candidate roots and the gradle cache root from override → env → project config → global config → `settings.xml` → default, mirroring `strategy.ts`. The Maven resolver parses classpath entries against **any** candidate and, when none match, derives the anchor from mvn's own output (majority vote, quorum ≥2). `openContext` computes roots once, threads them into the resolver options like `strategy`, and fingerprints the primary m2 root into the manifest hash.

**Tech Stack:** TypeScript (Node ≥20.12, ESM, `tsc` strict), vitest 4, @clack/prompts for the init prompt. **No new npm dependencies.**

## Global Constraints

- No new npm dependencies; stdlib only (`node:fs`, `node:os`, `node:path`).
- Env beats config for the new roots (the `buildTool` rationale in `docs/design.md`); `primeMode`'s config-beats-env is untouched.
- Everything degrades, never throws: absent/corrupt config, missing env, unparseable `settings.xml` each fall through to the next layer.
- The three-line stderr warning budget is global: the new `m2-anchor-derived` warning rides the existing `warnings` array, never direct stderr writes.
- Cross-platform paths: case-insensitive prefix matching for windows drive-letter skew stays (`parseM2Entry` contract); all new paths join via `node:path`.
- Test env vars via `vi.stubEnv` + `vi.unstubAllEnvs` (house pattern, see `test/unit/strategy.test.ts`); scratch dirs via `mkdtempSync(tmpdir())`, removed in `afterEach`.
- Conventional-commit messages; each task ends committed.
- Run tests: `npx vitest run <file>` from repo root; full gate `npm test && npm run typecheck`.

---

### Task 1: Roots convergence module

**Files:**
- Create: `src/resolver/roots.ts`
- Test: `test/unit/roots.test.ts`

**Interfaces:**
- Consumes: `PRIME_CONFIG_PATH` from `src/prime/command.ts` (`.jarpeek/config.json` relative path).
- Produces (all later tasks rely on these exact shapes):

```ts
export type RootSource = "override" | "env" | "config" | "settings" | "default";
export interface RootCandidate { path: string; source: RootSource; }
export interface RootsOptions {
  /** Top-precedence single m2 root (resolver `opts.m2Dir` DI). */
  m2Dir?: string;
  /** Top-precedence gradle cache dir (scan `opts.gradleDir` DI). */
  gradleDir?: string;
  /** User settings.xml location; default `join(homedir(), ".m2", "settings.xml")` — real home, NOT JARPEEK_HOME. */
  settingsPath?: string;
}
export interface EffectiveRoots { m2: RootCandidate[]; gradle: RootCandidate; }

export function effectiveM2Roots(projectRoot: string | undefined, opts?: RootsOptions): RootCandidate[];
export function effectiveGradleCacheRoot(projectRoot: string | undefined, opts?: RootsOptions): RootCandidate;
export function effectiveRoots(projectRoot: string | undefined, opts?: RootsOptions): EffectiveRoots;
```

- `effectiveM2Roots` order (first valid wins the "primary" slot; list is the full candidate set for the Maven resolver):
  1. `opts.m2Dir` (source `override`)
  2. `process.env.JARPEEK_M2_DIR` (source `env`)
  3. `process.env.M2_REPO` (source `env`)
  4. `m2Dir` field of `<projectRoot>/.jarpeek/config.json` (source `config`)
  5. `m2Dir` field of the global config (source `config`)
  6. `<localRepository>` from the user settings.xml (source `settings`)
  7. `join(homedir(), ".m2", "repository")` (source `default`) — always present, so the list is never empty
- `effectiveGradleCacheRoot` order: `opts.gradleDir` (`override`) → `JARPEEK_GRADLE_CACHE_DIR` (`env`) → `join(process.env.GRADLE_USER_HOME, "caches", "modules-2", "files-2.1")` (`env`) → project config `gradleCacheDir` (`config`) → global config `gradleCacheDir` (`config`) → `join(homedir(), ".gradle", "caches", "modules-2", "files-2.1")` (`default`). Returns one candidate (first valid).
- Global config path: `join(process.env.JARPEEK_HOME ?? homedir(), ".config", "jarpeek", "config.json")`.
- Validity rules: empty/whitespace strings drop out; config-file values must be absolute (`path.isAbsolute`) or they drop out silently; corrupt JSON drops out silently. When `projectRoot` is `undefined`, the config layers are skipped entirely (env/settings/default still apply).
- `settings.xml` parsing (no XML dep): read the file, take the **first** substring between `<localRepository>` and `</localRepository>`, trim it, replace every `${user.home}` occurrence with `homedir()`, require the result to be absolute. Comments and profile-scoped variants are not honored (documented limitation, one doc-comment line). Read failure → no candidate.
- Dedup: exact string match against earlier entries in the m2 list (a later layer naming the same path as an earlier one adds nothing).

- [x] **Step 1: Write the failing tests** — `test/unit/roots.test.ts`, house pattern from `strategy.test.ts` (scratch root, `writeConfig`, `vi.stubEnv`). Scenarios, each asserting the returned candidates' `path` + `source` array:
  - nothing set → single default `~/.m2/repository` (`default`) for m2; gradle default for gradle.
  - `opts.m2Dir` override beats every env/config/settings layer.
  - `JARPEEK_M2_DIR` beats `M2_REPO`; both present → both listed, env order preserved.
  - env beats project config; project config beats global config; global config beats settings.xml; settings.xml beats default.
  - settings.xml: a fixture file with `<localRepository>/custom/m2</localRepository>` yields that path (source `settings`); `${user.home}` interpolation resolves; a relative `<localRepository>` value is dropped (falls to default); missing file → default.
  - gradle: `JARPEEK_GRADLE_CACHE_DIR` beats `GRADLE_USER_HOME`-derived; `GRADLE_USER_HOME=/g` yields `/g/caches/modules-2/files-2.1`; config layers follow the same order.
  - config validity: relative `m2Dir` in project config drops out; corrupt JSON drops out; `undefined` projectRoot skips config layers.
  - `JARPEEK_HOME` relocates the global config (write a global config under a scratch home, stub `JARPEEK_HOME`, assert it is read).
  - dedup: `JARPEEK_M2_DIR` equal to the default path → exactly one candidate.
- [x] **Step 2: Run to verify failure** — `npx vitest run test/unit/roots.test.ts` → FAIL (module not found).
- [x] **Step 3: Implement `src/resolver/roots.ts`** per the Interfaces block: module doc-comment stating the precedence and the env-beats-config rationale; private helpers for reading a config field (shared by project + global), parsing settings.xml, and validity filtering; every read guarded by try/catch returning "absent".
- [x] **Step 4: Run to verify pass** — `npx vitest run test/unit/roots.test.ts` → PASS. `npm run typecheck` → clean.
- [x] **Step 5: Commit** — `git add src/resolver/roots.ts test/unit/roots.test.ts && git commit -m "feat(resolver): cache-root convergence module"`

### Task 2: Maven multi-anchor parse with derived fallback

**Files:**
- Modify: `src/resolver/maven.ts` (`ResolveMavenOptions`, `MavenResolution`, `parseOutputs`, `resolveMaven` ~line 347-460; `parseM2Entry` stays)
- Test: `test/unit/maven-resolver.test.ts`

**Interfaces:**
- Consumes: `effectiveM2Roots(projectRoot, { m2Dir })` from Task 1.
- Produces:
  - `ResolveMavenOptions.roots?: { m2: string[] }` — when present, replaces the self-computed candidate list entirely (context threading, Task 4); `opts.m2Dir` remains the top of the self-computed chain and keeps working alone (existing tests rely on it).
  - `MavenResolution.warnings?: string[]` — new optional channel; carries `maven: m2-anchor-derived:<path>` when derivation engaged. The facade (Task 4) merges it into `ResolutionOutcome.warnings`.
- Behavior:
  - `resolveMaven` computes `m2Dirs = opts.roots?.m2 ?? effectiveM2Roots(projectRoot, { m2Dir: opts.m2Dir }).map(c => c.path)`.
  - `parseOutputs(outputs, m2Dirs, projectRoot, modules)` — each raw entry tries every anchor in order; the first anchor under which `parseM2Entry` succeeds wins. Module `target/classes` matching is per-entry and unchanged.
  - Derivation: only when the outputs carried content (`sawContent`) yet **zero** entries mapped. For every raw entry whose last three `/`-separated segments satisfy the stem contract (`<a>/<v>/<a>-<v>.jar`, ≥1 group segment before them — i.e. the existing layout shape applied to the entry tail without knowing the root), the derived anchor is the entry's prefix before those three segments. Group entries by derived anchor; the anchor backed by the most **distinct entries** wins; accept it only at quorum ≥2. Then re-parse all outputs with `m2Dirs + [derived]` and set `warnings: ["maven: m2-anchor-derived:<derived>"]` on the successful resolution. A lone layout-shaped entry (e.g. a system-scoped jar) maps to nothing — today's protection.
  - Failure reasons are unchanged (`classpath-not-in-m2-layout` still fires when derivation also fails or makes nothing map).
- [x] **Step 1: Write the failing tests** (extend `test/unit/maven-resolver.test.ts`; reuse `materialize`/`stubExec`/`scratch` helpers):
  - GH#12 regression: classpath jars materialized under a scratch custom root, `vi.stubEnv("JARPEEK_M2_DIR", customRoot)` → resolution `ok`, expected coordinates, no derivation warning.
  - `M2_REPO` stub honored the same way.
  - multi-anchor: classpath entries split across two scratch roots, both passed via `opts.m2Dir` + env root → all entries map.
  - `opts.roots.m2` threading: same custom-root scenario driven through `roots` instead of env.
  - derivation: custom root, no env/config/settings set (assert the candidate list can't match — e.g. point the default away by overriding only `settingsPath`… simpler: materialize under custom root and pass `m2Dir` of an unrelated scratch root, with a **second** and third jar sharing the same custom root so quorum ≥2 holds) → `ok`, coordinates correct, `warnings` contains `maven: m2-anchor-derived:<custom root>`.
  - quorum guard: a single layout-shaped entry under an unknown root → `ok: false`, reason `mvn-failed:classpath-not-in-m2-layout`, no warnings.
  - system-jar protection: one non-layout entry mixed into a normal resolved classpath → it is skipped, resolution `ok`, no derivation.
  - derive-then-warn plumbing: the `warnings` field is absent on plain default-root resolutions.
- [x] **Step 2: Run to verify failure** — `npx vitest run test/unit/maven-resolver.test.ts` → new cases FAIL.
- [x] **Step 3: Implement** per Interfaces: restructure `parseOutputs` into entry collection → anchored mapping pass → (when empty) derivation + re-map; return `{ resolution, warnings }`; thread through `resolveMaven`; `vi.unstubAllEnvs` in the file's `afterEach` if not already present.
- [x] **Step 4: Run to verify pass** — whole file PASS; existing cases untouched semantics (they pass `m2Dir`).
- [x] **Step 5: Commit** — `git add src/resolver/maven.ts test/unit/maven-resolver.test.ts && git commit -m "fix(resolver): honor relocated m2 roots — multi-anchor parse with derived fallback (GH#12)"`

### Task 3: Cache scan re-rooted

**Files:**
- Modify: `src/resolver/cache-scan.ts` (`scanCaches`, `ScanCachesOptions`)
- Test: `test/unit/cache-scan.test.ts`

**Interfaces:**
- Consumes: `effectiveM2Roots`, `effectiveGradleCacheRoot` from Task 1.
- Produces: `ScanCachesOptions.projectRoot?: string` — when given, config layers join the convergence; `m2Dir`/`gradleDir` remain top-precedence DI overrides. The scanned m2 root is the **primary** (first) m2 candidate; the gradle root is the single gradle candidate.
- [x] **Step 1: Write the failing tests**: with a scratch `projectRoot` carrying `.jarpeek/config.json` `{ "m2Dir": <scratch m2> }` and `{ "gradleCacheDir": <scratch gradle> }` (two cases), `scanCaches({ projectRoot })` walks the config dirs (assert found coordinates), not `~`; with `opts.m2Dir` also passed, the explicit dir wins; with no `projectRoot`, env-only chain applies (stub `JARPEEK_GRADLE_CACHE_DIR`, assert honored — preserving the existing behavior the output-budget e2e relies on).
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement**: replace the two inline default expressions in `scanCaches` with roots-module calls; update the module doc-comment's env-override note to point at `roots.ts`.
- [x] **Step 4: Run to verify pass** — `npx vitest run test/unit/cache-scan.test.ts` + `test/integration/output-budget.test.ts` (it depends on the env behavior) → PASS.
- [x] **Step 5: Commit** — `git add src/resolver/cache-scan.ts test/unit/cache-scan.test.ts && git commit -m "feat(resolver): cache scan honors the roots convergence"`

### Task 4: Facade threading + warning merge

**Files:**
- Modify: `src/resolver/index.ts` (`ResolveDependenciesOptions`, `resolveDependencies`)
- Test: `test/unit/resolver-facade.test.ts`

**Interfaces:**
- Consumes: Task 2 `MavenResolution.warnings`; Task 3 `ScanCachesOptions.projectRoot`.
- Produces: `ResolveDependenciesOptions.roots?: { m2: string[]; gradle: string }` — threaded to `resolveMaven({ roots })` (full m2 list) and to `scanCaches({ projectRoot, m2Dir: roots.m2[0], gradleDir: roots.gradle })` (primary only). On a winning Maven resolution, `resolution.warnings` are appended to the outcome `warnings` after the artifacts are accepted; gradle and cache-scan warning paths unchanged.
- [x] **Step 1: Write the failing tests**: injected fake maven resolver returning `ok` with `warnings: ["maven: m2-anchor-derived:/x"]` → outcome `warnings` contains it; injected fakes capturing their options assert maven received the full `roots.m2` and the cache scan received `projectRoot` + primary root + gradle root when `opts.roots` is set; without `opts.roots`, the cache scan still receives `projectRoot` (config layers live).
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement** per Interfaces (the facade loop already breaks on the winner — append warnings at the same sites).
- [x] **Step 4: Run to verify pass** — resolver-facade + maven-resolver + cache-scan files PASS.
- [x] **Step 5: Commit** — `git add src/resolver/index.ts test/unit/resolver-facade.test.ts && git commit -m "feat(resolver): thread effective roots through the facade, surface derivation warnings"`

### Task 5: Context convergence + manifest fingerprint

**Files:**
- Modify: `src/core/query/context.ts`, `src/index/manifest.ts`
- Test: `test/unit/manifest.test.ts`, `test/unit/context-strategy.test.ts` (or a sibling `context-roots.test.ts` in the same style)

**Interfaces:**
- Consumes: `effectiveRoots(projectRoot)` from Task 1; `ResolveDependenciesOptions.roots` from Task 4.
- Produces:
  - `QueryContext.roots: EffectiveRoots` (with sources — status needs them); `openContext` computes it once: `opts.resolvers?.roots` (already `ResolverRoots`-shaped) does **not** short-circuit this — the context always computes `effectiveRoots(projectRoot)` for its own record, and threads `{ m2: roots.m2.map(c => c.path), gradle: roots.gradle.path }` into `resolvers` exactly like `strategy`.
  - `computeDependencySetHash(projectRoot, strategy, m2Root: string)` and `isStale(projectRoot, m, strategy, m2Root: string)` — new **required** third/fourth param; one more hash line `m2Root\t${m2Root}` (sorted with the rest). All call sites updated (compiler-enumerated; `context.ts` passes `ctx.roots.m2[0].path`, `status.ts` likewise).
- [x] **Step 1: Write the failing tests**: hash — same build files, different `m2Root` → different hash; staleness — a manifest written under root A reports stale when checked under root B; context — `openContext` with `vi.stubEnv("JARPEEK_M2_DIR", …)` exposes it via `ctx.roots.m2[0]` with source `env`, and re-opens with a different env → different `ctx.roots` (no caching across contexts).
- [x] **Step 2: Run to verify failure** (typecheck also fails on the new required param — expected at this step).
- [x] **Step 3: Implement** per Interfaces; keep the doc-comments' fingerprint rationale updated (one sentence: the effective m2 root is part of the dependency set's identity for the same reason the strategy is).
- [x] **Step 4: Run to verify pass** — `npx vitest run test/unit/manifest.test.ts test/unit/context-strategy.test.ts` + `npm run typecheck` → clean (status.ts call sites fixed in this task if the compiler names them; its renderer test lands in Task 6).
- [x] **Step 5: Commit** — `git add src/core/query/context.ts src/index/manifest.ts test/unit/manifest.test.ts && git commit -m "feat(core): roots join the context convergence and the manifest fingerprint"`

### Task 6: Status rows

**Files:**
- Modify: `src/core/query/status.ts`, `src/cli/index.ts` (`renderStatus` ~line 270)
- Test: `test/unit/status.test.ts`

**Interfaces:**
- Consumes: `ctx.roots` from Task 5.
- Produces: `StatusResult.resolver: { m2Root: RootCandidate; gradleCacheRoot: RootCandidate }`; text rendering adds two rows `resolver.m2Root` / `resolver.gradleCacheRoot` rendered as `<path> (<source>)`; JSON output carries the structured object. No staleness semantics change.
- [x] **Step 1: Write the failing tests**: a context opened with `JARPEEK_M2_DIR` stubbed reports `resolver.m2Root.path` equal to it and `source "env"`; default context reports the default path with `source "default"`; `renderStatus`-level assertion (via the CLI smoke harness if one exists for status, else direct call) that the row text is `<path> (env)`.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement** per Interfaces.
- [x] **Step 4: Run to verify pass** — `npx vitest run test/unit/status.test.ts test/unit/cli-smoke.test.ts` → PASS.
- [x] **Step 5: Commit** — `git add src/core/query/status.ts src/cli/index.ts test/unit/status.test.ts && git commit -m "feat(status): report effective resolver cache roots and their source"`

### Task 7: Init advanced step + global config write path

**Files:**
- Modify: `src/harness/init.ts` (`PromptIo`, `clackPromptIo`, `runInit`, generalize `writePrimeMode`), `src/harness/wiring.ts` only if the home helper is shared (else none)
- Test: `test/integration/init.test.ts`

**Interfaces:**
- Consumes: `effectiveRoots(projectRoot)` from Task 1; `PRIME_CONFIG_PATH`.
- Produces:
  - `PromptIo.text(message: string, placeholder?: string): Promise<string>` — @clack/prompts `text` with the same cancel guard; the fake in tests returns the scripted string.
  - `InitResolvers.effectiveRoots?: typeof effectiveRoots` — detection seam so tests never touch the real home/settings.
  - In `runInit` (interactive branch only, after the mode select): two text prompts — "Maven local repository override" and "Gradle cache override". Each prompt's default value is the existing config field (empty when unset), its placeholder shows the detected root (`detected: <primary path> — leave empty to keep following Maven`). A trimmed non-empty answer is persisted; empty omits the field.
  - Persistence via a generalized private helper `updateProjectConfig(projectRoot, fields: Record<string, string>)` — read-modify-write of `.jarpeek/config.json` preserving other fields, 2-space JSON + trailing newline (today's `writePrimeMode` format); `writePrimeMode` becomes a call to it with `{ primeMode: mode }`.
  - `InitResult.notes` gains one line when any root field was written: `cache roots pinned in .jarpeek/config.json`. Non-interactive (`yes`) and prompt-less flows skip the step entirely and write nothing.
  - Idempotency contract preserved: re-running with the same answers (including the same non-empty override, because it is the prompt default) changes zero bytes.
- [x] **Step 1: Write the failing tests** (extend the existing prompt-replay harness; add `text` to `fakePrompts` with per-test answers): override persisted → config.json contains `m2Dir` and the note appears; empty answers → config has no `m2Dir`/`gradleCacheDir`, no note; `--yes` path → step skipped, config untouched by roots; re-run with the same override as default → idempotency hash unchanged; detection seam receives a fake `effectiveRoots` → placeholder source is the fake's primary path (assert via the message/placeholder argument the fake `text` captured).
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement** per Interfaces.
- [x] **Step 4: Run to verify pass** — `npx vitest run test/integration/init.test.ts` → PASS.
- [x] **Step 5: Commit** — `git add src/harness/init.ts test/integration/init.test.ts && git commit -m "feat(init): advanced cache-root step — detected roots shown, overrides persisted"`

### Task 8: Docs

**Files:**
- Modify: `README.md` (configuration section, ~line 165-175), `docs/design.md` (resolve-cascade section, ~line 31-52)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - README table: `JARPEEK_M2_DIR`, `M2_REPO`, `JARPEEK_GRADLE_CACHE_DIR`, `GRADLE_USER_HOME` rows plus the `m2Dir`/`gradleCacheDir` config fields; one short "Global config" paragraph documenting `~/.config/jarpeek/config.json` (and `JARPEEK_HOME`'s effect on it), the full precedence order, and the derive-from-output fallback with its warning.
  - `docs/design.md`: extend the resolve-cascade paragraph with the roots convergence (candidate anchors, derivation quorum, `m2Root` fingerprint line) and add the precedence sentence (env > project config > global config > settings.xml > default) next to the existing `buildTool` precedence text.
- [x] **Step 1: Edit both docs** per Produces (overview altitude in README, decision-log altitude in design.md — match each file's existing density).
- [x] **Step 2: Verify** — `npm test && npm run typecheck` (full gate) → PASS.
- [x] **Step 3: Commit** — `git add README.md docs/design.md && git commit -m "docs: cache-root convergence — env, config, settings.xml, derivation"`

## Self-Review

1. **Code scan** — no method bodies or test code; behavior, contracts, and expected results only. ✓
2. **Self-containment** — every task restates its consumed/produced contracts; `RootSource`/`RootCandidate` defined in Task 1 and reused by name with shape reminders where far away (Task 6). ✓
3. **Spec coverage** — roots module (T1), multi-anchor + derive + warning (T2), cache-scan re-root (T3), threading (T4), fingerprint (T5), status (T6), init + global config (T7), docs (T8). The spec's "global config consumed fields" land in T1 (read) and T7 (write path context); GH#12 regression in T2. ✓
4. **Placeholders** — none. ✓
5. **Type consistency** — `RootCandidate`/`EffectiveRoots` (Task 1) vs the plain `roots?: { m2: string[]; gradle: string }` resolver option (Tasks 2/4) are deliberately distinct shapes, named consistently across tasks; `computeDependencySetHash`/`isStale` signatures updated identically in Task 5's Consumes/Produces. ✓
