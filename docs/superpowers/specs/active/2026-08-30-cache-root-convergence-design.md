# Cache-root convergence — following Maven wherever it puts the repository

**Status:** in_progress

## Problem

`JARPEEK_M2_DIR` steers the cache-scan resolver but not the Maven
resolver: `src/resolver/maven.ts` anchors classpath parsing on a
hardcoded `~/.m2/repository`. With a relocated local repository, `mvn
dependency:build-classpath` succeeds and prints entries under the real
root, every entry fails the layout check, and the resolution degrades
with `mvn-failed:classpath-not-in-m2-layout` into a cache scan that
returns the entire repository's contents as "dependencies" (GH#12: 340
artifacts in every project). Beyond the one-line gap, the audit behind
the fix found the customization surface thin: standard tool env vars
(`M2_REPO`, `GRADLE_USER_HOME`) and maven's own `settings.xml`
`<localRepository>` are ignored, cache roots have no config-file surface
although `.jarpeek/config.json` already exists, and there is no global
(machine-wide) config at all — yet a relocated repository is exactly a
machine-wide fact.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | Fix plus config surface in one change: robust anchor discovery, config-file fields (project and global), init integration. Absorbs the resolver half of beads `jvm-src-8d8` (its cache-scan roots + m2-anchor items); `list_classes` stays there. |
| 2 | Anchor discovery is hybrid: explicit candidate roots first (preserving today's behavior whenever one matches), then — only when candidates match nothing — a root derived from mvn's own output. Covers `-Dmaven.repo.local` and every mechanism never enumerated. |
| 3 | Env beats config for the new roots (the `buildTool` reasoning in `docs/design.md`: hand-authored per-machine state; one-off shell overrides must win). `primeMode`'s config-beats-env is untouched. |
| 4 | `jarpeek init` gains an interactive advanced step (no build runs — "init never resolves" holds); detected roots are shown, only an explicit user override is persisted. |
| 5 | No new CLI flags (`--m2-dir` etc.): env covers one-off overrides, config covers persistent state, and config is the only surface an MCP-spawned server can reach. |
| 6 | The effective m2 root joins the dependency-set fingerprint: a root flip re-resolves instead of serving a wrong-root manifest — the `buildTool` staleness argument, and the same one-time re-resolve for upgrading users. |

## Design

### New module `src/resolver/roots.ts` — one convergence point

Mirrors `strategy.ts` (config read per call, injectable environment and
settings path for tests, never throws, never writes). Two functions:

- `effectiveM2Roots(projectRoot)` — a deduplicated candidate list:
  `JARPEEK_M2_DIR` → `M2_REPO` → project `.jarpeek/config.json` `m2Dir`
  → global config `m2Dir` → `settings.xml` `<localRepository>` (user
  `~/.m2/settings.xml`; `${user.home}` interpolated; absent or
  unparseable contributes nothing) → default `~/.m2/repository`. An
  explicit `opts.m2Dir` (or the resolver's threaded `roots`) replaces
  the chain rather than topping it — test injection names exactly one
  anchor and cannot accidentally pick up a real env layer.
- `effectiveGradleCacheRoot(projectRoot)` — `JARPEEK_GRADLE_CACHE_DIR` →
  `GRADLE_USER_HOME`-derived `<it>/caches/modules-2/files-2.1` → project
  config `gradleCacheDir` → global config `gradleCacheDir` → default
  `~/.gradle/caches/modules-2/files-2.1`.

Config values must be absolute paths; relative or non-string values fall
through to the next layer silently, matching invalid-`buildTool`
behavior.

### Maven resolver: multi-anchor parse with derived fallback

`parseOutputs` in `src/resolver/maven.ts` matches each classpath entry
against **any** candidate root instead of one hardcoded anchor — a
classpath spanning several configured roots parses completely. The
per-entry layout contract (`<group…>/<artifact>/<version>/<a>-<v>.jar`,
group variable-depth, case-insensitive prefix per `parseM2Entry`) is
unchanged. When no entry anchors anywhere (anchor hits, not artifacts —
module `target/classes` entries never count), derivation engages: each
layout-shaped entry proposes every repository-named path boundary above
its layout tail (`m2`, `repository`, `repo`, digit-suffixed and
delimiter-compound spellings) as a candidate anchor; the candidate backed
by the most distinct entries wins, deepest breaking ties, at a quorum of
two. Majority voting keeps a stray system-scoped jar from dragging the
anchor to a shared ancestor, and requiring a recognized boundary refuses
derivation for a too-blandly-named root — the loud
`classpath-not-in-m2-layout` failure — rather than guessing coordinates.
A successful derivation adds `warning: maven: m2-anchor-derived:<path>`
to the resolution warnings, so this failure class is visible instead of
silently degrading into cache-scan artifact soup. An explicit
`ResolveMavenOptions.m2Dir` (or threaded `roots`) replaces the candidate
chain rather than topping it — the caller said exactly where to look.

### Cache scan

`scanCaches` in `src/resolver/cache-scan.ts` takes its default roots from
the new module (first m2 candidate; the gradle root), replacing its
inline env reads; `ScanCachesOptions.m2Dir` / `gradleDir` remain test
overrides.

### Plumbing and manifest invalidation

`openContext` computes the effective roots once, next to the
`effectiveBuildToolStrategy` call (`src/core/query/context.ts`), and
threads them through a new `ResolveDependenciesOptions.roots` field;
resolvers self-compute when called directly (tests, `jarpeek resolve`),
the same dual path `strategy` follows. The `dependencySetHash` input in
`src/index/manifest.ts` gains an `m2Root` line naming the effective
primary root, so flipping the layer that owns the primary slot re-resolves
rather than serving a manifest resolved against another root (a
non-primary layer flip changes the candidate list but not the hash —
accepted; the primary is the root the scan walks and the status reports).

### Global config file

`~/.config/jarpeek/config.json`, resolved under the `JARPEEK_HOME`
override (the same testability rationale as user-scoped harness writes,
`src/harness/wiring.ts`). Same document shape as the project config;
only `m2Dir` and `gradleCacheDir` are consumed from it for now. Absent or
corrupt falls through to the next layer.

### Init integration

`PromptIo` in `src/harness/init.ts` gains a `text` primitive. A new
advanced step, after the existing ones, shows the detected effective
roots in the prompt's placeholder ("detected: /custom/m2 — leave empty to
keep following Maven"). Empty input omits the field; an entered path is
persisted to the project `.jarpeek/config.json` alongside `primeMode`.
Detection reads env, configs, and `settings.xml` only — no build tool
runs. The non-interactive path skips the step.

### Status observability

`jarpeek status` gains `resolver.m2Root` and `resolver.gradleCacheRoot`
rows (the effective values with their source layer — `env`, `config`,
`settings.xml`, `default`), making a GH#12-class misconfiguration a
one-command diagnosis.

## Testing

- Roots convergence: the full precedence matrix (injection > env > project
  config > global config > settings.xml > default), env-beats-config,
  `JARPEEK_HOME`-scoping the global config, `${user.home}` interpolation,
  relative-path fallthrough, injectable settings path.
- Maven: GH#12 regression (`JARPEEK_M2_DIR` honored), `M2_REPO`,
  settings.xml fixture, multi-root classpath, derive quorum and
  single-entry non-mapping, module-entries-don't-suppress-derivation,
  stray-entry isolation, unrecognized-root refusal, the
  `m2-anchor-derived` warning.
- Cache scan: default roots come from the module (both knobs).
- Manifest: flipping any layer changes the fingerprint and forces
  re-resolution.
- Init: the text step persists an override, omits on empty, and is skipped
  non-interactively.
- Status: effective roots and source layers are reported.

## Open Questions

None.
