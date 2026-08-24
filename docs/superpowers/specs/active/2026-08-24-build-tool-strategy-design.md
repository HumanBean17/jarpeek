# Build-tool selection strategy — system-first with wrapper fallback

**Status:** in_progress

## Problem

`selectCommand` in `src/resolver/maven.ts` and `src/resolver/gradle.ts`
hardcodes a wrapper-first preference: an `mvnw`/`mvnw.cmd` (or
`gradlew`/`gradlew.bat`) at the project root wins over a system
`mvn`/`gradle` from PATH, and nothing can change that. Users whose wrapper
is CI-only — it cannot run on their machine (distribution download
blocked, exec failure) — are blocked: the wrapper resolve fails, the
cascade degrades to cache-scan, and queries never adopt a cache-scan
manifest, so every query answers as a miss. There is no override.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | The default flips to system-first: the system `mvn`/`gradle` is preferred when its PATH probe passes; the root wrapper becomes the fallback. |
| 2 | Fallback triggers on absence **and** failure: any `ok: false` from the first candidate (spawn error, timeout, build failure, empty classpath) advances to the next. This closes the version-skew regression — a system tool present but wrong for the project — at the cost of a second build run on failed resolves. |
| 3 | One tri-state knob covers both tools: `auto` \| `system` \| `wrapper`. |
| 4 | Three surfaces with precedence **flag > env > config > auto**: sticky global `--build-tool`, `JARPEEK_BUILD_TOOL`, `.jarpeek/config.json` `"buildTool"`. Invalid env/config values fall through to the next layer (primeMode's behavior); an invalid flag value is a commander `choices` error. The precedence deviates from primeMode's flag > config > env deliberately: that config is `init`-written wiring, this one is hand-authored, and env-over-config keeps one-off shell overrides working. |
| 5 | Selection and retry live inside each resolver; the cascade in `resolver/index.ts`, reactor `partial` semantics, and the degradation contract are untouched. |
| 6 | The effective strategy joins the dependency-set fingerprint: flipping the knob re-resolves instead of serving the manifest the other tool produced. |
| 7 | Force means force: `system` with no system tool degrades with the existing absence reason (`no-mvn` for Maven, the Gradle resolver's equivalent); `wrapper` with no wrapper file fails with a new distinct reason — no silent fallthrough. |

## Design

### Strategy type and convergence

New `src/resolver/strategy.ts` exports `BuildToolStrategy`
(`"auto" | "system" | "wrapper"`) and the convergence function
`effectiveBuildToolStrategy(projectRoot, flagValue?)`: the CLI flag when
given, else `JARPEEK_BUILD_TOOL`, else the `buildTool` field of
`.jarpeek/config.json`, else `"auto"`. The config path constant is shared
with `prime/command.ts` (`PRIME_CONFIG_PATH`). Absent, corrupt, or
invalid env/config values are ignored and fall through to the next layer.

### Candidate selection

Each resolver's private `selectCommand` grows into ordered-candidate
selection parameterized by strategy. Platform plumbing — win32
`cmd /c` wrapping, PATH probes with PATHEXT — stays per-resolver, exactly
where it is:

| strategy | candidates, in order |
|---|---|
| `auto` (new default) | system (if PATH probe passes) → wrapper (if present at root) |
| `system` | system only; probe failure degrades with the existing absence reason |
| `wrapper` | wrapper only; a missing wrapper file is a new distinct reason (e.g. `no-wrapper`) |

With no candidate at all, the resolution fails exactly as today's absence
path does.

### Retry and failure reporting

The resolver runs candidates in order; the first `ok` wins.
`dependency:sources` (and the Gradle equivalent) runs only for the winning
candidate, exactly as today. When every candidate fails, the resolution
returns one combined reason naming each attempt with its existing
failure-detail tail, flowing through the unchanged `degraded[]` /
warnings machinery under the same three-line budget.

### Plumbing

`ResolveDependenciesOptions` gains a `strategy` field threaded into both
resolvers' options. The CLI resolves the strategy once per invocation
(`src/cli/index.ts`, sticky global flag) and the MCP server once at
startup (`src/mcp/server.ts`, env + config only — flags cannot reach a
spawned server); both pass it through `OpenContextOptions.resolvers` into
`openContext` → `resolveDependencies`. Every subcommand, `jarpeek
resolve` included, inherits it.

### Manifest invalidation

The `dependencySetHash` input gains the effective strategy alongside the
build-file lines, so a flip forces re-resolution. Tool upgrades under an
unchanged strategy stay unfingerprinted, as today.

### Docs and help

The README configuration table gains `--build-tool`,
`JARPEEK_BUILD_TOOL`, and the `buildTool` config field; the
`docs/design.md` resolve-cascade section is rewritten to system-first
with fallback and the override; `--help` lists the flag with its values.

## Testing

- Ordering: per strategy × {system probe passes/fails × wrapper
  present/absent}, driven through the injected PATH probes and `exec`.
- Retry: a failing system candidate advances to the wrapper; the winner's
  sources fetch runs; a double failure yields the combined reason naming
  both attempts.
- Forced modes: `system`-only degrades with the absence reason;
  `wrapper`-only with no wrapper file fails with the distinct reason.
- Convergence: flag > env > config > `auto`; invalid env/config values
  fall through; an invalid flag value exits 1 naming the choices.
- Manifest: flipping the strategy changes the fingerprint and forces
  re-resolution.
- Cross-platform: every test stubs the PATH probes — windows CI images
  ship Gradle on PATH, so a real probe would flake per platform.

## Open Questions

None.
