# Build-Tool Selection Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip build-tool command selection to system-first with wrapper fallback (on absence and failure), controlled by a tri-state `auto | system | wrapper` knob exposed as `--build-tool`, `JARPEEK_BUILD_TOOL`, and `.jarpeek/config.json` `buildTool`.

**Architecture:** A new `src/resolver/strategy.ts` owns the tri-state type and the flag > env > config convergence. Each resolver (`maven.ts`, `gradle.ts`) grows ordered-candidate selection and an internal retry loop — the facade and degradation contract are untouched. `openContext` converges the strategy once, threads it into `resolveDependencies` and the manifest fingerprint, so a strategy flip forces re-resolution. The MCP server needs no code change (it opens a context; convergence reads env + config there).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node filesystem APIs, commander 12, vitest 4.

## Global Constraints

- No new dependencies.
- ESM imports use `.js` specifiers (e.g. `import ... from "./strategy.js"`).
- Every failing resolution degrades to `{ ok: false, reason }`; the resolver never throws for recognized failures, and any single invocation stays within the three-line stderr warning budget (unchanged machinery).
- `system` = the bare `mvn`/`gradle` selected via the existing PATH probes (`mvnOnPathDefault`, `gradleOnPathDefault`); `wrapper` = the root `mvnw`/`mvnw.cmd`/`gradlew`/`gradlew.bat` via the existing platform selection (win32 goes through `cmd /c`).
- Combined-failure reason format (used by both resolvers): when ≥ 2 candidates ran and all failed — `mvn-failed:system: <d1> | wrapper: <d2>` (Gradle: `gradle-failed:system: <d1> | wrapper: <d2>`), where each `<dN>` is exactly the detail that attempt would have produced as a solo failure: `timeout`, a spawn-error message, a stderr/stdout tail (existing `failureDetail` text), `no-classpath` (Maven), `classpath-not-in-m2-layout` (Maven), `no-output`/`bad-json` (Gradle). When exactly one candidate ran, today's solo reason formats are kept verbatim.
- Tests never rely on the real PATH probes or real mvn/gradle — windows CI images ship Gradle on PATH, so unstubbed probes flake per platform. Use the injectable `mvnOnPath`/`gradleOnPath` options and `stubPlatform`/`stubExec` idioms already in `test/unit/maven-resolver.test.ts` and `test/unit/gradle-resolver.test.ts`.
- Conventional commits (`feat(scope):`, `test:`, `docs:`), one per task.
- Run tests with `npx vitest run test/unit/<file>.test.ts` for task-scoped runs; full suite `npm test`.

---

### Task 1: Strategy module (`src/resolver/strategy.ts`)

**Files:**
- Create: `src/resolver/strategy.ts`
- Test: `test/unit/strategy.test.ts`

**Interfaces:**
- Consumes: `PRIME_CONFIG_PATH` (`.jarpeek/config.json` relative path constant) exported from `src/prime/command.ts`.
- Produces:
  - `export type BuildToolStrategy = "auto" | "system" | "wrapper";`
  - `export const BUILD_TOOL_STRATEGIES: readonly BuildToolStrategy[]` — exactly `["auto", "system", "wrapper"]` (single source for validation and CLI choices).
  - `export function effectiveBuildToolStrategy(projectRoot: string, flagValue?: string): BuildToolStrategy` — precedence: `flagValue` when it is one of the three values → env `JARPEEK_BUILD_TOOL` when one of the three → the `buildTool` field of the JSON document at `join(projectRoot, PRIME_CONFIG_PATH)` when one of the three → `"auto"`. An absent, corrupt (JSON parse failure), or invalid value at any layer falls through to the next layer. No filesystem write, no throw.

- [x] **Step 1: Write the failing tests**

`test/unit/strategy.test.ts` with a scratch project dir (`mkdtempSync`, cleaned in `afterEach`) and `vi.stubEnv`/`vi.unstubAllEnvs` for the env var. Scenarios, each asserting the return of `effectiveBuildToolStrategy`:

1. No flag, no env, no config file → `"auto"`.
2. Flag `"wrapper"`, env `"system"`, config `"system"` → `"wrapper"` (flag beats everything).
3. No flag, env `"system"`, config `"wrapper"` → `"system"` (env beats config).
4. No flag, no env, config file containing `{"buildTool":"wrapper"}` → `"wrapper"`.
5. Config file containing `{"primeMode":"cli"}` (field absent) → `"auto"` (falls through).
6. Corrupt config file (not JSON) → `"auto"`.
7. Config `{"buildTool":"nonsense"}` and env `"garbage"` → `"auto"` (invalid values fall through).
8. Flag `"garbage"` (defensive; commander blocks this in practice) with env `"system"` → `"system"`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/strategy.test.ts`
Expected: FAIL — module `../../src/resolver/strategy.js` cannot be resolved.

- [x] **Step 3: Write the implementation**

`src/resolver/strategy.ts`: the type and array as specified above; `effectiveBuildToolStrategy` implementing the precedence chain. Config reading mirrors `readPrimeModeConfig` in `src/prime/command.ts`: `JSON.parse(readFileSync(...))` inside try/catch, then check the `buildTool` field is one of the three strings. Validate `flagValue` and env through the same membership check against `BUILD_TOOL_STRATEGIES`. File header comment documents the knob, its three surfaces, and the precedence (flag > env > config > auto), noting the deliberate deviation from primeMode's flag > config > env.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/strategy.test.ts`
Expected: PASS (all 8 scenarios).

- [x] **Step 5: Commit**

Run: `git add src/resolver/strategy.ts test/unit/strategy.test.ts`
Run: `git commit -m "feat(resolver): build-tool strategy type and flag/env/config convergence"`

---

### Task 2: Maven resolver — candidates and retry

**Files:**
- Modify: `src/resolver/maven.ts` (`selectCommand` at lines 53–76, `resolveMaven` at lines 319–407, `ResolveMavenOptions` at 43–51, `MavenResolution` at 31–41)
- Test: `test/unit/maven-resolver.test.ts`

**Interfaces:**
- Consumes: `BuildToolStrategy` from `src/resolver/strategy.ts`.
- Produces:
  - `ResolveMavenOptions` gains `strategy?: BuildToolStrategy` — undefined means `"auto"`.
  - `MavenResolution["reason"]` union gains `"no-wrapper"`.
  - Candidate semantics (internal, replacing `selectCommand`): an ordered candidate list where each candidate is the existing platform-shaped command (`command`, `preArgs`) tagged `via: "system" | "wrapper"`. Order by strategy:
    - `"auto"`: system candidate first **iff** `opts.mvnOnPath ?? mvnOnPathDefault` passes, then wrapper candidate iff `mvnw`/`mvnw.cmd` exists at root.
    - `"system"`: system candidate iff the probe passes; probe failure → immediate `{ ok:false, reason:"no-mvn" }` (today's absence reason).
    - `"wrapper"`: wrapper candidate iff the wrapper file exists; missing → `{ ok:false, reason:"no-wrapper" }`.
    - Empty candidate list under `"auto"` (no system, no wrapper) → `{ ok:false, reason:"no-mvn" }`.
  - Retry semantics: run candidates in order; the first attempt whose run parses to `ok:true` wins (including `partial` results — a partial is a success, never retried). Any failed attempt (non-zero exit, `TimeoutError`, `SpawnError`, empty/`no-classpath` outputs, non-m2 layout) advances to the next candidate. All attempts fail → combined reason per the Global Constraints format. A `SpawnError` during an attempt is an attempt failure with the error message as its detail — it no longer maps to `no-mvn` (absence is decided by the probe, before any spawn).
  - `dependency:sources` runs exactly once, with the winning candidate's command, after the winning run (unchanged best-effort semantics, still runs for `partial` wins).

- [x] **Step 1: Write the failing tests**

Extend `test/unit/maven-resolver.test.ts` using the existing `stubExec`, `stubPlatform`, `scratch`, `PROBE_FOUND` idioms; write a wrapper file (`mvnw`, chmod executable) and a fake m2 jar via the existing fixture helpers where a successful parse is needed. New scenarios:

1. **auto prefers system**: probe passes, `mvnw` exists → first `exec` call is bare `mvn` with the build-classpath args; a working system run never invokes the wrapper.
2. **auto falls back on absence**: probe fails, `mvnw` exists → the only command used is the wrapper path.
3. **auto retries on failure**: probe passes, `mvnw` exists; system run exits non-zero, wrapper run succeeds (writes the classpath fixture) → result `ok:true`, `exec` calls show system-then-wrapper order, and the `dependency:sources` call uses the **wrapper** command exactly once.
4. **auto combined failure**: both candidates fail (non-zero, no outputs) → `ok:false`, reason matches `mvn-failed:system: <system detail> | wrapper: <wrapper detail>` where each detail is the `failureDetail` tail that attempt would produce solo.
5. **system strategy**: probe passes, `mvnw` exists → only bare `mvn` runs; wrapper never invoked.
6. **system strategy, probe fails** → `ok:false`, reason `"no-mvn"`, zero `exec` calls.
7. **wrapper strategy**: `mvnw` exists, probe passes → only the wrapper runs.
8. **wrapper strategy, no wrapper file** → `ok:false`, reason `"no-wrapper"`, zero `exec` calls.
9. **timeout advances**: probe passes, wrapper exists, system attempt throws `TimeoutError`, wrapper succeeds → `ok:true`.
10. **win32 auto**: `stubPlatform("win32")`, `mvnw.cmd` exists, probe passes → first call is `cmd /c mvn` (system via cmd), fallback attempt is `cmd /c <root>/mvnw.cmd`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/maven-resolver.test.ts`
Expected: FAIL — new scenarios fail (`strategy` option unrecognized: system-first order asserted but wrapper runs first; `no-wrapper` reason absent).

- [x] **Step 3: Update existing tests to the new default**

Existing tests that place a wrapper and also pass `PROBE_FOUND` (or otherwise reach the bare path) currently assert wrapper-first command selection — flip their expected command order to system-first, or stub the probe to fail where the test's intent is "wrapper project" (see the file's existing wrappers around `mvnw` chmod/fixtures). Tests that pass `opts.exec` with a wrapper-only scratch and no probe stub keep passing only if the probe fails on the scratch environment — make every affected test's probe stubbing explicit while touching it. Tests using `opts.mvnOnPath` stay valid.

- [x] **Step 4: Implement candidates + retry in `maven.ts`**

Restructure `resolveMaven`: compute the candidate list per the Interfaces table; extract the per-attempt body (pre-clean target files, run `dependency:build-classpath` with the candidate's command, collect outputs, `parseOutputs`) into an internal helper taking one candidate; loop candidates with the retry rule; on total failure return the combined reason; on a win run `dependency:sources` with the winner and return the parsed result (preserving `partial` computation from the winning run). Target-file cleanup (`rmSync`) stays in a `finally` covering all targets. `selectCommand`'s doc comment is rewritten to describe candidate order per strategy. Update the file header comment's "no mvn anywhere" sentence to name probe-absence vs per-attempt failure.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/maven-resolver.test.ts`
Expected: PASS (new + updated scenarios).

- [x] **Step 6: Commit**

Run: `git add src/resolver/maven.ts test/unit/maven-resolver.test.ts`
Run: `git commit -m "feat(resolver): maven system-first candidate selection with wrapper retry"`

---

### Task 3: Gradle resolver — candidates and retry

**Files:**
- Modify: `src/resolver/gradle.ts` (`selectCommand` at 145–169, `resolveGradle` at 202–259, `ResolveGradleOptions` at 32–40, `GradleResolution` at 26–30)
- Test: `test/unit/gradle-resolver.test.ts`

**Interfaces:**
- Consumes: `BuildToolStrategy` from `src/resolver/strategy.ts`.
- Produces:
  - `ResolveGradleOptions` gains `strategy?: BuildToolStrategy` — undefined means `"auto"`. The existing `wrapper?: string` explicit-command override is preserved: when set, it is the single candidate and strategy is ignored (existing tests depend on it).
  - `GradleResolution["reason"]` union gains `"no-wrapper"`.
  - Candidate semantics mirror Task 2 exactly, with `gradleOnPathDefault` as the probe, `gradlew`/`gradlew.bat` as the wrapper, and absence reasons: empty list under `"auto"` or probe failure under `"system"` → `"no-wrapper-no-gradle"` (today's both-absent reason); missing wrapper under `"wrapper"` → `"no-wrapper"`.
  - Retry semantics mirror Task 2: first `ok:true` wins; any failed attempt (non-zero exit, `TimeoutError`, `SpawnError`, `no-output`, `bad-json`) advances; total failure → combined reason per Global Constraints (`gradle-failed:system: <d1> | wrapper: <d2>`; solo attempts keep today's formats). `SpawnError` during an attempt is an attempt failure (error message as detail), not `"no-wrapper-no-gradle"` — absence is the probe's decision.
  - The init script (`ensureGradleInitScript`) is ensured once per resolution, not per attempt.

- [x] **Step 1: Write the failing tests**

Extend `test/unit/gradle-resolver.test.ts` using its existing idioms (`SAMPLE_OUTPUT` fixture, sentinel output builder, `INIT_ARGS`, `stubExec`, `PROBE_FOUND`, `stubPlatform`):

1. **auto prefers system**: probe passes, `gradlew` exists → first `exec` call is bare `gradle` with `INIT_ARGS`; wrapper never invoked on success.
2. **auto falls back on absence**: probe fails, `gradlew` exists → wrapper is the only command.
3. **auto retries on failure**: system run exits non-zero, wrapper run prints the sentinel document → `ok:true`; call order system-then-wrapper.
4. **auto combined failure**: both fail → `ok:false`, reason `gradle-failed:system: <d1> | wrapper: <d2>`.
5. **system strategy**: probe passes, wrapper exists → only bare `gradle`; **probe fails** → `"no-wrapper-no-gradle"`, zero calls.
6. **wrapper strategy**: wrapper exists → only wrapper runs; **no wrapper file** → `"no-wrapper"`, zero calls.
7. **`opts.wrapper` bypass**: explicit wrapper command + any strategy → that command is the only candidate (regression guard for existing tests).
8. **win32 auto**: `stubPlatform("win32")`, `gradlew.bat` exists, probe passes → system first via `cmd /c gradle`, fallback `cmd /c <root>/gradlew.bat`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/gradle-resolver.test.ts`
Expected: FAIL — `strategy` option unrecognized, system-first order asserted but wrapper runs first.

- [x] **Step 3: Update existing tests to the new default**

Same exercise as Task 2 Step 3: tests with both a wrapper and a passing probe flip to system-first expectations or pin the probe to failing; make probe stubs explicit everywhere a command selection is asserted.

- [x] **Step 4: Implement candidates + retry in `gradle.ts`**

Mirror Task 2's restructure: candidate list per strategy, `opts.wrapper` short-circuit preserved, per-attempt run of the existing exec/sentinel/parse sequence, retry rule, combined reason, `ensureGradleInitScript` hoisted before the loop. Rewrite `selectCommand`'s doc comment for candidate order; update the file header's "missing wrapper plus no Gradle on PATH" sentence.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/gradle-resolver.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

Run: `git add src/resolver/gradle.ts test/unit/gradle-resolver.test.ts`
Run: `git commit -m "feat(resolver): gradle system-first candidate selection with wrapper retry"`

---

### Task 4: Facade threading

**Files:**
- Modify: `src/resolver/index.ts` (`ResolveDependenciesOptions` at 41–48, `resolveDependencies` at 72–127)
- Test: `test/unit/resolver-facade.test.ts`

**Interfaces:**
- Consumes: `BuildToolStrategy` (Task 1); `ResolveMavenOptions.strategy` (Task 2); `ResolveGradleOptions.strategy` (Task 3).
- Produces: `ResolveDependenciesOptions` gains `strategy?: BuildToolStrategy`. `resolveDependencies` passes `strategy: opts.strategy` into both resolvers' options objects (undefined flows through as `undefined`, which each resolver treats as `"auto"`). Nothing else in the cascade changes.

- [x] **Step 1: Write the failing test**

Extend `test/unit/resolver-facade.test.ts` (it already injects stub resolvers via `opts.gradle`/`opts.maven`): calling `resolveDependencies(root, { strategy: "wrapper", gradle: stub, maven: stub, ... })` with a succeeding gradle stub asserts the stub received `strategy: "wrapper"` in its options argument; a call without `strategy` asserts the stub received `strategy: undefined`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/resolver-facade.test.ts`
Expected: FAIL — stub receives no `strategy` field.

- [x] **Step 3: Implement the threading**

Add the option to `ResolveDependenciesOptions`; include `strategy: opts.strategy` in the option objects built for the `gradle` and `maven` calls; update the facade doc comment with one sentence naming the strategy knob and its default.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/resolver-facade.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add src/resolver/index.ts test/unit/resolver-facade.test.ts`
Run: `git commit -m "feat(resolver): thread build-tool strategy through the facade"`

---

### Task 5: Manifest fingerprint includes the strategy

**Files:**
- Modify: `src/index/manifest.ts` (`computeDependencySetHash` at 85–99, `isStale` at 109–123), plus its two production callers as mechanical updates: `src/core/query/context.ts` (lines 150 and 184) and `src/core/query/resolve-cmd.ts` (line 36)
- Test: `test/unit/manifest.test.ts`

**Interfaces:**
- Consumes: `BuildToolStrategy` (Task 1).
- Produces:
  - `computeDependencySetHash(projectRoot: string, strategy: BuildToolStrategy): Promise<string>` — **required** second parameter. The hashed line set gains `strategy\t<value>` alongside the build-file lines (deterministic position in the sorted join; sorting already applies).
  - `isStale(projectRoot: string, m: Manifest, strategy: BuildToolStrategy): Promise<boolean>` — required third parameter; delegates with it.
  - Callers in `context.ts` and `resolve-cmd.ts` pass `"auto"` in this task as a literal (the real converged value arrives in Task 6). This is an intentional intermediate state so every commit compiles and passes.

- [x] **Step 1: Write the failing tests**

Extend `test/unit/manifest.test.ts` (scratch dir with a `pom.xml`):

1. Same scratch + same strategy → `computeDependencySetHash` is stable across calls.
2. Same scratch, `"auto"` vs `"wrapper"` → different hashes.
3. A manifest written with hash(`"wrapper"`) → `isStale(..., "auto")` is `true` (fingerprint moved), `isStale(..., "wrapper")` is `false`.

Update existing direct calls to `computeDependencySetHash`/`isStale` in this file to pass `"auto"`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/manifest.test.ts`
Expected: FAIL — arity/type errors against the old signatures (or scenario 2/3 assertions fail once signatures updated by the test edit).

- [x] **Step 3: Implement**

Change both signatures; include the strategy line in the hashed input; pass `"auto"` at the three production call sites in `context.ts` (two) and `resolve-cmd.ts` (one), each with a brief comment `// real strategy threaded in the context-wiring change`. Extend the doc comments of both functions to name the strategy line and why (flipping the knob must re-resolve, not serve the other tool's manifest).

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/manifest.test.ts test/unit/context-listings.test.ts test/unit/status.test.ts`
Expected: PASS (manifest new scenarios + every suite touching the changed signatures).

- [x] **Step 5: Commit**

Run: `git add src/index/manifest.ts src/core/query/context.ts src/core/query/resolve-cmd.ts test/unit/manifest.test.ts`
Run: `git commit -m "feat(index): strategy joins the dependency-set fingerprint"`

---

### Task 6: Context convergence and wiring

**Files:**
- Modify: `src/core/query/context.ts` (`OpenContextOptions` at 64–73, `QueryContext` at 45–62, `openContext` at 98–211), `src/core/query/resolve-cmd.ts` (line 36)
- Test: Create `test/unit/context-strategy.test.ts`

**Interfaces:**
- Consumes: `effectiveBuildToolStrategy` (Task 1); `ResolveDependenciesOptions.strategy` (Task 4); `computeDependencySetHash(root, strategy)` / `isStale(root, m, strategy)` (Task 5).
- Produces:
  - `OpenContextOptions` gains `buildToolFlag?: string` — the raw CLI flag value, unconstrained (commander validates at the surface; invalid values fall through inside convergence).
  - `QueryContext` gains `readonly buildTool: BuildToolStrategy` — the effective strategy this context resolves and hashes under.
  - `QueryContext["resolvers"]` is now always defined: `openContext` computes `strategy = opts.resolvers?.strategy ?? effectiveBuildToolStrategy(projectRoot, opts.buildToolFlag)` and stores `resolvers: { ...opts.resolvers, strategy }`. An explicitly injected `opts.resolvers.strategy` (tests) wins over convergence.
  - `ensureReady`'s staleness check (`isStale`) and the bootstrap's `writeManifest` hash both use the context's strategy; `resolveNow` (resolve-cmd.ts) hashes with `ctx.buildTool` and keeps `resolveDependencies(ctx.projectRoot, ctx.resolvers)` as-is (strategy rides inside `ctx.resolvers`).
  - The MCP server (`src/mcp/server.ts`) requires **no change**: it opens a context without `buildToolFlag`, so convergence reads env + config.

- [x] **Step 1: Write the failing tests**

`test/unit/context-strategy.test.ts`, scratch project with a `pom.xml`, injecting stub resolvers via `opts.resolvers.{gradle,maven,cacheScan,jdk}` (the established `openContext` injection pattern; note `openContext` captures `Date.now` at construction — pass `opts.now` where timing matters):

1. **Flag reaches resolvers**: `openContext(root, { buildToolFlag: "wrapper", resolvers: { gradle: captureStub, ... } })`, force a bootstrap (`ensureReady` with no manifest) → the captured gradle stub's options include `strategy: "wrapper"`.
2. **Env convergence**: `vi.stubEnv("JARPEEK_BUILD_TOOL", "system")`, no flag → captured stub sees `strategy: "system"`.
3. **Config convergence**: write `.jarpeek/config.json` with `{"buildTool":"wrapper"}`, no flag, no env → stub sees `"wrapper"`.
4. **Flag beats env**: flag `"system"` + env `"wrapper"` → stub sees `"system"`.
5. **Injected strategy wins**: `resolvers: { strategy: "wrapper", ... }` + env `"system"` → stub sees `"wrapper"` (test-injection precedence).
6. **Hash flips staleness**: bootstrap once with `buildToolFlag: "wrapper"` (writes a manifest), reopen with `buildToolFlag: "system"` and the same stub resolvers → `ensureReady` re-bootstraps (manifest stale via strategy fingerprint), not short-circuits.
7. **Default with nothing set** → stub sees `strategy: "auto"`; `ctx.buildTool` equals the same value on every scenario.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/context-strategy.test.ts`
Expected: FAIL — `buildToolFlag` unrecognized (convergence never happens; scenarios 1–6 fail).

- [x] **Step 3: Implement in `context.ts` and `resolve-cmd.ts`**

Add `buildToolFlag` to `OpenContextOptions`; compute the effective strategy once in `openContext`; always populate `resolvers` (spread + strategy) and the new `buildTool` field on the returned context; replace the three `"auto"` literals from Task 5 (`isStale` call, `writeManifest` hash in `runBootstrap`, `computeDependencySetHash` in `resolveNow`) with the context's strategy. Extend the `openContext` doc comment: one sentence on convergence (flag > env > config > auto) and one on the fingerprint tie-in.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/context-strategy.test.ts test/unit/context-listings.test.ts test/unit/context-heartbeat.test.ts test/unit/status.test.ts`
Expected: PASS (new scenarios + every context suite green).

- [x] **Step 5: Commit**

Run: `git add src/core/query/context.ts src/core/query/resolve-cmd.ts test/unit/context-strategy.test.ts`
Run: `git commit -m "feat(core): openContext converges build-tool strategy; fingerprint keyed to it"`

---

### Task 7: CLI flag

**Files:**
- Modify: `src/cli/index.ts` (`GlobalOptions` at 71–74, `Invocation` at 77–80, `ctxFor` at 83–87, program options at 333–339, `invocation()` at 357–360)
- Test: `test/unit/cli-smoke.test.ts`, `test/unit/cli-help.test.ts`

**Interfaces:**
- Consumes: `BUILD_TOOL_STRATEGIES` (Task 1); `OpenContextOptions.buildToolFlag` (Task 6).
- Produces:
  - Program-level sticky global option `--build-tool <strategy>` declared with commander `Option(...).choices([...BUILD_TOOL_STRATEGIES])` — invalid values exit 1 with commander's choices error naming all three values; the flag renders with its values in every `--help` options table automatically.
  - `GlobalOptions.buildTool?: string`; `Invocation.buildTool?: string` (raw string, `program.opts()` value); `ctxFor` passes `buildToolFlag: inv.buildTool` into `openContext`.

- [x] **Step 1: Write the failing tests**

Following the CLI spawn idiom already used by `test/unit/cli-smoke.test.ts` and `test/unit/cli-help.test.ts` (spawn from the repo root via the `--import tsx` form used there):

1. `jarpeek --build-tool bogus find-class X` exits 1, stderr contains `build-tool` and the three valid values (commander choices error).
2. `jarpeek --help` output contains `--build-tool`.
3. Flag accepted end-to-end: `jarpeek --build-tool system status --json` exits 0 (the value flows through convergence; no crash on an invalid layer).

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/cli-smoke.test.ts test/unit/cli-help.test.ts`
Expected: FAIL — unknown option error on `--build-tool` (scenarios 1–2 fail).

- [x] **Step 3: Implement**

Add the option with choices from `BUILD_TOOL_STRATEGIES` to the program-level chain; add `buildTool` to `GlobalOptions`/`Invocation`/`invocation()`; pass `buildToolFlag` in `ctxFor`. One-line option description naming the semantics: which command runs resolves (system mvn/gradle from PATH, the root wrapper, or system-first with wrapper fallback).

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/cli-smoke.test.ts test/unit/cli-help.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

Run: `git add src/cli/index.ts test/unit/cli-smoke.test.ts test/unit/cli-help.test.ts`
Run: `git commit -m "feat(cli): --build-tool global flag with tri-state choices"`

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (Configuration table at ~157–171; the resolve-cascade sentence wherever the README describes wrapper use), `docs/design.md` (the "resolve cascade" section at ~30–37)
- Test: none (documentation; verified by reading)

**Interfaces:**
- Consumes: everything above (final behavior).
- Produces: docs matching shipped behavior, preserving each doc's altitude (README = overview, design.md = rationale).

- [x] **Step 1: Update README**

Configuration table: add rows `--build-tool <auto|system|wrapper>` (CLI global flag; which mvn/gradle runs resolves), `JARPEEK_BUILD_TOOL` (env; beats config, loses to the flag), `.jarpeek/config.json` `"buildTool"` (persistent per-machine default). Add one prose sentence stating the selection default: system mvn/gradle from PATH first, root wrapper as fallback (including after a failed system run), and that flipping the setting re-resolves. Fix any README sentence that says the wrapper is preferred.

- [x] **Step 2: Update `docs/design.md`**

Rewrite the resolve-cascade section's command-selection sentences to system-first with wrapper fallback on absence and failure, name the tri-state knob and its precedence, and add one sentence on the strategy-in-fingerprint rule (a flip forces re-resolution). Keep the section's length and altitude; do not add a changelog.

- [x] **Step 3: Verify docs against behavior**

Re-read both files against the shipped flag/help output (`npx tsx src/cli/index.ts --help`); confirm no stale "wrapper is used by default" claims remain (`grep -rn "wrapper" README.md docs/design.md`).

- [x] **Step 4: Commit**

Run: `git add README.md docs/design.md`
Run: `git commit -m "docs: system-first build-tool selection and the --build-tool knob"`

---

## Self-Review (run after writing; results recorded here)

1. **Code scan:** No method bodies, algorithms, or copy-paste code — signatures, tables, and behavior descriptions only. ✔
2. **Self-containment:** Every task repeats its consumed contracts (types, option names, reason strings, formats) — no "see Task N" for interfaces. ✔
3. **Spec coverage:** Spec decisions 1–7 → Task 2/3 (candidates, retry, force semantics), Task 1 (convergence + precedence + invalid fallthrough), Task 5/6 (fingerprint), Task 7 (flag + help), Task 8 (README + design.md). MCP no-change requirement honored in Task 6. ✔
4. **Placeholder scan:** No TBD/TODO; the Task 5 `"auto"` literals are an explicit, justified sequencing step, not missing design. ✔
5. **Type consistency:** `BuildToolStrategy`, `BUILD_TOOL_STRATEGIES`, `effectiveBuildToolStrategy(projectRoot, flagValue?)`, `strategy?: BuildToolStrategy` (all three option interfaces), `reason` gains `"no-wrapper"`, `buildToolFlag?: string`, `ctx.buildTool` — names used identically across tasks. ✔
