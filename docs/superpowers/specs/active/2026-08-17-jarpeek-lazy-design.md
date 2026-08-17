# jarpeek lazy redesign — no index, read jars on demand

**Status:** in_progress

## Problem

Real-world test of v1 on a 350-artifact Gradle project (`find-class KafkaTemplate`)
failed on all three product promises:

1. **It froze.** The first query auto-bootstrapped a resolve + index pass that
   parsed every file of every artifact (~100k+ files: hibernate-core 7968,
   bcprov 5993, byte-buddy 2845, ...) and wrote per-artifact declaration
   shards — tens of minutes of work to answer one class-name lookup.
2. **It polluted.** One `[jarpeek] indexing ...` line per artifact (350 lines)
   went to stderr — straight into the agent's context window.
3. **It hoarded.** Declaration shards plus caches grew the on-disk footprint
   into hundreds of MB the user never asked for.

Root cause: v1's core loop was *index-first* (`ensureReady` → resolve +
`indexArtifacts` for the whole dependency set, `src/core/query/context.ts`),
inherited from the archived v1 spec's "lazy bootstrap" row — which was
anything but lazy.

### Principles (locked)

- **Laziness**: work is proportional to what was asked, never to the size of
  the dependency set. No automatic indexing — no indexing at all.
- **YAGNI**: the whole project is never processed to answer a question about
  one class.
- **Agentic-first output**: stdout carries the answer and nothing else;
  diagnostics are bounded to a handful of lines; a slower answer is always
  preferable to a frozen agent or a fat cache.

### Key structural fact

The core navigation loop never needed the content index. Zip **central
directories** give class-name → jar mapping with one positional read per jar
(no decompression; the existing pure-TS reader in `src/parse/zip.ts` already
works this way). `outline`/`read_member`/`read_source` need to parse exactly
one file per call. Only member-name search (`search_symbols`) requires
reading class content across a set — and it becomes artifact-scoped.

## Locked decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | Queries **auto-resolve** when the manifest is missing or stale (one bounded Gradle/Maven run), but **never index**. Resolution failure still answers the query (miss + reason). |
| 2 | Stale manifest triggers the same auto-resolve; if it fails, the stale manifest serves, flagged. |
| 3 | `search_symbols` requires an artifact argument (`--artifact g:a:v`); it reads one jar's content on demand. |
| 4 | The **manifest is the only derived state on disk**. Listings and decompile results live in process memory only. |
| 5 | Approach chosen: fully lazy, no index subsystem. An opt-in "warm" index was rejected — it keeps the machinery (shards, locks, staleness, unbounded cache) that caused the v1 failure. Incremental index-on-touch was rejected for the same reason plus first-touch freezes. |

## Architecture

```
┌─────────┐  ┌─────────┐
│ MCP stdio│  │   CLI   │      same core, 1:1 mapping (unchanged)
└────┬────┘  └────┬────┘
     └──────┬─────┘
      ┌─────▼──────────┐
      │  query layer    │  same 9 tools; every tool = locate → parse-one-file
      ├────────────────┤
      │ listing service │  in-process zip central-dir listings,
      │  (memory only)  │  artifact → entry names, validated by (mtime, size)
      ├────────────────┤
      │ one-file parsers│  Java/Kotlin lexers, class-file reader — unchanged,
      │                 │  now parsing exactly one entry per call
      ├────────────────┤
      │ decompile       │  CFR per-class (unchanged adapter), in-process memo
      ├────────────────┤
      │ resolvers       │  gradle · maven · jdk(src.zip); cache-scan explicit-only
      └────────────────┘
```

The MCP server (long-lived) holds listings and decompile memos for its
lifetime. One-shot CLI invocations rebuild them per run (~1-3s listing scan,
~0.5s JVM boot per decompile) — the accepted price of zero disk state.

## Components

### Manifest v2 — the only derived state on disk

`.jarpeek/manifest.json` (project-local, gitignored), written by `resolve` or
by the auto-resolve:

```json
{
  "version": 2,
  "resolvedAt": "2026-08-17T12:00:00.000Z",
  "dependencySetHash": "sha256 over build files (unchanged fingerprint)",
  "artifacts": [
    {
      "coordinates": "org.springframework.kafka:spring-kafka:3.2.0",
      "kind": "external",
      "configuration": "compile",
      "binaryJar": "~/.gradle/caches/.../spring-kafka-3.2.0.jar",
      "sourcesJar": "~/.gradle/caches/.../spring-kafka-3.2.0-sources.jar",
      "sourceDir": "optional; multi-module sibling"
    }
  ]
}
```

- No per-artifact `provenance`, `warnings`, or `sourceSig` — provenance is
  computed per answer (below); per-artifact warnings no longer exist at
  resolve time.
- Staleness = build-file fingerprint mismatch or any recorded artifact path
  no longer existing. The `sourceSig` source-tree hashing is dropped (it
  re-walked module source trees on every staleness check — another hidden
  v1 cost).
- v1 manifests read as absent; the next query auto-resolves and rewrites v2.

### Listing service (new, in-process only)

Artifact → entry names, from the first available of: `binaryJar`
(`*.class` entries), `sourcesJar` (`*.java`/`*.kt` entries), `sourceDir`
(one lazy tree walk). Held in a process-lifetime map keyed by coordinates and
validated by the source's `(mtime, size)` — a jar swapped on disk mid-process
is re-listed. FQN derivation: `a/b/C.class` → `a.b.C`; nested classes keep
`$` (`a/b/Outer$Inner.class` → `a.b.Outer$Inner`); entries whose simple name
(after the last `$` or `.`) does not start a Java identifier are skipped —
the same anonymous/local-class filter the v1 indexer applied. Unreadable
jars skip the artifact and aggregate into one warning.

### Provenance — computed per answer, never stored

- `source` — the artifact has a sources jar/dir containing the file.
- `decompiled` — binary-only artifact, JVM available; CFR serves on read.
- `signature` — binary-only without a JVM (or CFR failed), or a
  sources-entry miss answered from bytecode.

`find_class` reports provenance as this promise, computed from manifest
metadata plus one cached JVM probe — zero content reads.

### One-file parse paths

All reads locate the artifact via listings, then parse exactly one entry:
source entry (Java/Kotlin lexers, line ranges for member spans), class entry
(class-file reader, signatures), or CFR output (adapter unchanged; its disk
cache becomes an in-process memo — the temp-dir round-trip through CFR
stays). Name normalization maps `$` (entries, bytecode) ↔ `.` (source-lexed
nested classes) consistently so binary and source artifacts resolve nested
classes identically. FQN collisions across artifacts: winner by manifest
order, rest as `alternatives` (unchanged contract).

### Resolvers

- Gradle and Maven resolvers unchanged (init-script dump / effective
  classpath, lenient degradation, 180s timeout).
- JDK pseudo-artifact: `src.zip` only. The `jimage` extraction fallback is
  deleted; without `src.zip`, JDK lookups miss with a note. (`src.zip` is
  itself just a zip — the listing service reads it like any artifact.)
- Cache-scan remains the explicit `resolve` command's last-resort fallback
  (gradle → maven → cache-scan). **Queries never fall back to cache-scan** —
  a failed auto-resolve answers as a miss with the resolver's reason.
- The 60s failed-bootstrap backoff stays: a broken build must not re-run per
  query.

### Query-layer contracts

| Tool | Lazy path | Change vs v1 |
|---|---|---|
| `find_class` | Scan in-process listings; tiers unchanged (exact FQN → segment suffix → simple → fuzzy). `kind` parsed from the class/source header of the returned hits only (≤ `limit` reads). | No index read; no bootstrap indexing |
| `outline` | Listings locate the jar → parse one file → class row + members + nested rows | Backing swapped |
| `read_member` | Same locate → member spans from the one file; binary+JVM → CFR memo; else "signature only" | CFR disk cache → memo |
| `read_source` | Same locate → `outline`/`full`/`lines` over the one file | Backing swapped |
| `read_resource` | One artifact's listing + entry reads | Essentially unchanged |
| `search_symbols` | `--artifact g:a:v` **mandatory**; parses that one artifact's content, memoized in-process by `(coordinates, mtime)`. Unknown artifact → miss with did-you-mean from the manifest. | Was global-index-backed |
| `resolve` | Resolver cascade + manifest v2 write. Output: one summary line (`resolved 354 artifacts in 12.3s (2 warnings)`) + rare warning lines. | Per-artifact table deleted |
| `status` | Manifest presence/staleness, artifact count, JVM availability | Index fields deleted |
| `where` | Prints the artifact's on-disk paths (binary jar, sources jar, source dir) | Eager unpack-for-Grep deleted |

The miss protocol (fuzzy candidates → definitive negative listing searched
artifacts, exit 0) and the selector grammar (`#name`, `#name(Type,...)`)
survive unchanged; miss answers now derive candidates from listings.

**MCP/CLI parity**: same tool names and schemas except `search_symbols`
gains a required `artifact` argument and `where`/`resolve` result shapes slim
down. CLI `--json` remains the exact MCP result object.

### Output discipline — the agentic-first contract

- stdout: the answer, nothing else. Misses are answers, exit 0.
- **stderr hard cap: 3 lines per invocation**, enforced by tests:
  1. One `[jarpeek] resolving dependencies (first run | manifest stale)...`
     notice — only when an auto-resolve actually runs.
  2. ≤ 2 warning lines, deduped; overflow aggregates
     (`warning: 3 artifacts unreadable — see status`).
- No per-artifact output anywhere, ever.
- `resolve` prints one stdout summary line.

## Degradation ladder

| Situation | Behavior |
|---|---|
| Manifest missing or stale on a query | Auto-resolve (bounded, one notice line), then answer |
| Auto-resolve fails | Query answers as a miss: reason + `run jarpeek resolve for details`; 60s backoff |
| Resolve fails, stale manifest exists | Serve stale, `stale` flag + warning |
| Explicit `resolve`, build tools fail | Cascade to cache-scan, warnings carried in the result |
| No sources jar | CFR per-class on read, in-process memo |
| No JVM | `signature` floor |
| No `src.zip` | JDK lookups miss with a note |
| Jar unreadable during listing | Skip artifact; one aggregated warning |
| FQN in several artifacts | Manifest-order winner + `alternatives` |
| CFR fails / exotic lexer input | Signature + reason / flagged imprecision; raw file still readable |
| Concurrent invocations | Non-issue: manifest is the only writable state (tmp+rename) |

## What gets deleted

- `src/index/store.ts` (IndexStore, shards, directory.json, LRU), `src/index/indexer.ts`, `src/util/lockfile.ts`
- `indexArtifacts` and all per-artifact progress plumbing
- JDK `jimage` extraction; `where`'s unpacked-sources cache; CFR disk cache
- `sourceSig` manifest fields and their staleness hashing
- `JARPEEK_CACHE_DIR` configuration (nothing left to override); `ensureCacheDir`
- The "run first index" step of `init` (wiring only; hints that the first
  query auto-resolves)

Retained with new backing: `src/index/walk.ts` (module source-dir listings),
both lexers, class-file reader, zip reader, CFR adapter, resolvers,
selector/miss layers, harness wiring, MCP/CLI plumbing. `prime` content and
the README are rewritten for the new contracts.

## Testing

- **Deleted**: store, indexer, `sourceSig`, index-shape, bootstrap-index suites.
- **New unit**: listing service (FQN derivation, `$` filter, mtime
  invalidation, unreadable jars); provenance-promise computation; scoped
  `search_symbols` with memoization; `$`↔`.` normalization.
- **New contract tests**: stderr ≤ 3 lines on every fixture path including
  auto-resolve; stdout purity; `resolve`'s one-line output. The line budget
  is asserted as a product feature, alongside the existing outline
  context-cost budgets (kept).
- **Integration/e2e**: fixture projects driven with no cache directory in
  existence — proves nothing beyond the manifest is ever created; MCP golden
  transcripts updated; network e2e (`JARPEEK_E2E=1`) covers resolve-only flows.
- **Property**: every `find_class` hit's FQN round-trips to a readable jar
  entry.

## Versioning & migration

- `0.2.0`, breaking. Old global cache and decompiled dirs are simply unused;
  the README documents a one-liner `rm -rf`. No `clean` command.
- Kept configuration: `JARPEEK_HOME`, `JARPEEK_PRIME_MODE`, `.jarpeek/PRIME.md`,
  `.jarpeek/config.json`. `.jarpeek/` continues to hold the manifest and the
  Gradle init script.

## Non-goals

- Any persistent index, in any form, behind any flag.
- Global (unscoped) member-name search.
- JDK classes without `src.zip` (jimage parsing/extraction).
- Unpacked-source directories for external Grep (`where` prints paths; agents
  unpack themselves if they truly need to).
- Everything already outside v1 scope (type hierarchy, find-usages, remote
  artifact search, generated-source awareness).
