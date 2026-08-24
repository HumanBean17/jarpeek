# jarpeek design notes

Why jarpeek works the way it does: the 0.1 failure, the lazy redesign,
and the contracts that came out of it. For what the tools do day to day,
read the [README](../README.md).

## The 0.1 lesson: the index was the problem

jarpeek 0.1 served the same goal — context-frugal navigation — with an
eager index, and the index was the problem: the first query on a real
project parsed declarations from ~100,000 files across 350 artifacts — a
30-minute freeze while the agent waited, 350 lines of stderr spam, and a
fat derived cache on disk that went stale the moment the build moved.
0.2.0 shipped lazy instead, and every rule below traces back to that
failure.

## Lazy, and nothing else

- **One bounded resolve.** The first query on a fresh project (or after
  the build files change, or a recorded jar vanishes) runs one
  Gradle/Maven resolve and writes a manifest of the on-disk jars. That
  is all the up-front work there is: jarpeek never indexes.
- **Listings in memory.** Every query reads the manifest and opens jars
  through in-memory zip listings. The manifest is the only derived state
  on disk.
- **One-file parses.** A class lookup parses just the winning artifact's
  entry for that class — one source entry or class file (outline adds
  its directly nested classes) — never the jar around it.

## The resolve cascade

Resolution runs gradle → maven → local-machine cache scan, with the
cache scan an explicit last resort, and appends the local JDK when it
ships sources. Within each build tool the command is selected
system-first: the system `mvn`/`gradle` from PATH when its probe passes,
the root wrapper as fallback — and a failed first attempt (any cause)
advances to the wrapper inside the same resolution, so a version-skewed
system tool or a CI-only wrapper never blocks the resolve. The
`--build-tool` flag / `JARPEEK_BUILD_TOOL` env / `.jarpeek/config.json`
`buildTool` knob (precedence in that order) forces a direction; the
effective strategy is part of the manifest fingerprint, so flipping it
re-resolves instead of serving the other tool's manifest. The explicit
`jarpeek resolve` command keeps the full cascade and is the only writer
of a cache-scan-flagged manifest; **queries never adopt a cache-scan
manifest** — with a manifest on disk they are served from it, without
one they answer as a miss.

## Failure and degradation contract

- A resolve that fails never fails the query. With a manifest on disk it
  is served flagged `stale` with a warning; without one the query
  answers as a miss (an empty searched set).
- Re-resolution backs off for 60 seconds after a failure so a broken
  build is not re-run per query; `jarpeek resolve` re-runs the cascade
  on demand and reports the failure.
- Heartbeat exception to the quiet contract: while a resolve is actually
  running, one stderr line per 30s — a cold-cache first run downloads
  for minutes and silence reads as a hang.
- A Maven reactor where some modules resolve and one fails keeps the
  resolved set and names the failed modules.
- Degradations are reported, never hidden: each is a `warning: ...` line
  on stderr (a `degraded[]` field in JSON), aggregated so an invocation
  never exceeds the three-line warning budget.

## Gone by design

- **No index, ever.** The manifest is the only derived state jarpeek
  writes to disk.
- **No global member-name search.** `search_symbols` is scoped to one
  artifact and its `artifact` argument is required — scanning ~100,000
  declarations per query is the 0.1 failure in miniature.
- **No remote artifact search.** Maven Central lookup by coordinates is
  a planned extension, not a feature: on a miss, jarpeek reports what it
  searched and stops rather than fetching.

## Migrating from 0.1.x

0.2.0 was breaking: the eager index and its cache are gone. A v1
`.jarpeek` manifest is not read — the first query re-resolves and
rewrites it automatically. Old caches are unused and safe to delete:

    rm -rf ~/Library/Caches/jarpeek   # macOS; %LOCALAPPDATA%/jarpeek on Windows, ~/.cache/jarpeek elsewhere
