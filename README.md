# jarpeek

Context-frugal navigation into JVM dependency sources, for AI agents.

## Why

An agent working on a Gradle or Maven project that needs to know what
`SomeLibraryClient.builder()` actually does has bad options: read a
decompiled 3,000-line file whole (context gone), grep the binary jar
(noise), or guess from a doc page (hallucination risk). jarpeek gives the
agent the same navigation a human has in an IDE — find the class, see its
members, read exactly the method body asked for — at a fraction of the
token cost.

jarpeek 0.1 tried to serve that with an eager index, and the index was
the problem: the first query on a real project parsed declarations from
~100,000 files across 350 artifacts — a 30-minute freeze while the agent
waited, 350 lines of stderr spam, and a fat derived cache on disk that
went stale the moment the build moved. 0.2.0 is lazy instead:

- **One bounded resolve.** The first query on a fresh project (or after
  the build files change, or a recorded jar vanishes) runs one
  Gradle/Maven resolve — announced by a single stderr line — and writes
  a manifest of the on-disk jars. That is all the up-front work there
  is: jarpeek never indexes.
- **Listings in memory.** Every query reads the manifest and opens jars
  through in-memory zip listings. The manifest is the only derived
  state on disk.
- **One-file parses.** A class lookup parses just the winning artifact's
  entry for that class — one source entry or class file (outline adds its
  directly nested classes) — never the jar around it.
- **Outline first.** Declaration tables before source text; `read-source`
  defaults to an outline, `read-member` returns only the requested method
  spans.
- **Provenance on everything.** Every answer says whether it is `source`,
  `decompiled`, or `signature`, computed for that answer — so the agent
  knows what it is reading.
- **Misses are answers.** Unknown classes return suggestions and searched
  artifacts with exit code 0, never a stack trace.
- **Quiet by contract.** stderr is capped at three lines per invocation
  (one bootstrap notice plus at most two warning lines); stdout stays
  parseable.

jarpeek resolves through the project's own build (Gradle, then Maven,
then local machine caches as an explicit last resort), appends the local
JDK when it ships sources, and decompiles on demand with a bundled CFR.
It speaks MCP (a stdio subprocess, for harnesses that support it) and a
plain CLI (for everything else).

## Install

```
npm install -g jarpeek
jarpeek init
```

`init` detects the build system, wires the MCP server or CLI hints into
your AI harness (Claude Code, Codex, Gemini CLI, Qwen Code, GigaCode),
and stops there — no first index, no resolve. The first query
auto-resolves (or run `jarpeek resolve` yourself). `--yes` takes the
non-interactive defaults (Claude Code + MCP).

For a quick trial without installing, `npx jarpeek@latest init` also works
— but the wired configs invoke `jarpeek` by name, so install it globally
before relying on them (`init` warns when it is not on `PATH`).

Requirements: Node.js >= 20.12.0. A JVM on `PATH` (or `JAVA_HOME`) is
optional — without it, decompilation degrades to signature-only answers.

## Usage

### MCP

`jarpeek mcp` serves a stdio MCP server; `init` registers it for you. The
nine tools:

| Tool | Arguments | Answers with |
| --- | --- | --- |
| `find_class` | `query`, `limit?` | Matching classes by FQN, suffix, simple, or fuzzy name |
| `outline` | `fqn`, `kind?`, `visibility?` | Declaration rows — the frugal first look |
| `read_member` | `fqn`, `selectors[]` | Source slices for the named members |
| `read_source` | `fqn`, `mode?` (`outline`\|`full`\|`lines`), `from?`, `to?` | Source text for one class |
| `read_resource` | `artifact`, `glob` | Non-class jar entries (config, services, manifests) |
| `search_symbols` | `query`, `artifact` (required), `limit?`, `kind?` | Declarations by member name in one artifact |
| `resolve` | — | Forced re-resolve; one summary line (count, duration, warnings), plus the warnings when any |
| `status` | — | Manifest freshness (present, resolvedAt, stale, artifactCount) and JVM report |
| `where` | `coordinates` | The artifact's recorded on-disk paths, each flagged exists or missing |

Artifact arguments take full `g:a:v` coordinates or a unique artifact id
(the `a` segment).

### Resolution is lazy

Nothing needs to be primed by hand. The first query on a fresh project —
or the first query after the build files change or a recorded jar
vanishes — auto-resolves: one bounded Gradle/Maven pass, one stderr
notice line, and the manifest is rewritten. jarpeek never indexes; later
queries read the manifest and open only the jar entries they need.

A resolve that fails never fails the query. With a manifest on disk it
is served flagged `stale` with a warning; without one the query answers
as a miss (an empty searched set) and re-resolution backs off for
60 seconds so a broken build is not re-run per query — `jarpeek resolve`
re-runs the cascade on demand and reports the failure. Queries never
adopt the cache-scan heuristic set — the explicit `resolve` command
keeps the full gradle → maven → cache-scan cascade and is the only
writer of a flagged cache-scan manifest.

### CLI

Every tool is also a dash-named subcommand; `--json` prints the exact MCP
result object, `--project <dir>` picks the project root (default: cwd).
Member selectors are `#name` or `#name(Type,...)` for overloads.

```
jarpeek --json find-class StringJoiner --limit 5
jarpeek outline java.util.StringJoiner --kind method
jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'
jarpeek read-source com.example.lib.ApiClient --lines 40:80
jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'
jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method
jarpeek resolve
jarpeek status
jarpeek where com.example:demo-lib:1.0.0
```

`search-symbols` without `--artifact` is a usage error — the global
member scan is gone by design.

Also: `jarpeek init` (wire harnesses), `jarpeek prime` (print the agent
cheatsheet; `--full`, `--mcp`, `--export`, `--hook-json`), `jarpeek mcp`
(serve MCP stdio).

Diagnostics — the one bootstrap notice, warnings, degradations — go to
stderr under a three-line cap; stdout stays parseable. Unknown classes
exit 0 with suggestions.

## Provenance

Every answer carries one of three provenance values, computed for that
answer rather than stored anywhere:

- `source` — the artifact ships a sources jar (or module source dir). The
  real published code.
- `decompiled` — no sources jar; bytecode decompiled with the bundled CFR
  on the local JVM. Faithful in structure, but local names, generics, and
  control flow are the compiler's reconstruction. Treat fine detail
  accordingly.
- `signature` — no sources and no decompilation (JVM unavailable, JDK
  classes where decompilation is out of scope, or a failed decompile):
  declarations only. `read-member` answers "signature only" instead of
  code.

`find_class` hits carry the provenance as a promise — what reading that
class fully would yield — computed per hit from the artifact's backings
and JVM availability.

Degradations are reported, never hidden, and the answer still arrives: a
failed re-resolve serves the existing manifest flagged `stale`; a
resolution that degrades all the way to the cache scan is never adopted
by queries (served stale with a manifest, answered as a miss without
one). Each is a `warning: ...` line on stderr (a `degraded[]` field in
JSON), aggregated so an invocation never exceeds the three-line budget.
Search results are scoped to the project's resolved dependency set, and
`search_symbols` further to the one named artifact.

## Configuration

| Knob | Meaning |
| --- | --- |
| `JARPEEK_HOME` | Override the home directory used for user-scoped harness configs |
| `JARPEEK_PRIME_MODE` | Default `prime` mode (`cli` or `mcp`) when config is absent |
| `.jarpeek/PRIME.md` | Replaces the agent cheatsheet verbatim, every mode |
| `.jarpeek/config.json` | Written by `init`; records the wired `primeMode` |

`.jarpeek/` is per-machine state (the manifest, prime config) — gitignore
it (`init` adds it). The manifest is the only derived state jarpeek ever
writes to disk; old 0.1 caches are unused and safe to delete (see
[Migrating](#migrating-from-01x)).

## Development

```
npm run build        # tsc → dist/
npm test             # vitest run (unit + integration, offline)
npm run typecheck    # tsc --noEmit
node scripts/build-fixtures.mjs   # rebuild test fixture jars (deterministic)
```

Network-dependent e2e tests self-skip unless `JARPEEK_E2E=1` is set. Never
edit generated fixture jars by hand — edit `test/fixtures/src` and rerun
the build script.

## Limitations

- No type hierarchy, find-usages, or call-graph navigation — declaration
  lookup and source reads only.
- Global member-name search is gone by design: `search_symbols` is
  scoped to one artifact (the `artifact` argument is required).
- JDK classes need `$JAVA_HOME/lib/src.zip` — there is no jimage
  fallback. Without it, JDK classes are unavailable.
- Source-jar FQNs are derived from entry paths: a jar whose entries
  mismatch its declared packages can misreport a class's location.
- No generated-source awareness (protobuf, Dagger): generated classes
  appear only if they land in the resolved artifacts.
- Remote artifact search (Maven Central by coordinates) is a planned
  extension, not a feature: on a miss, jarpeek reports what it searched
  and stops rather than fetching.
- Maven SNAPSHOT dependencies resolved to timestamped jars
  (`artifact-1.0-20240501.123456-3.jar`) are not recognized by the Maven
  resolver's m2-layout matching and are skipped.
- Decompilation quality is CFR's; `signature` is the floor when no JVM is
  available.

## Migrating from 0.1.x

0.2.0 is breaking: the eager index and its cache are gone. A v1
`.jarpeek` manifest is not read — the first query re-resolves and
rewrites it automatically. Old caches are unused and safe to delete:

```
rm -rf ~/Library/Caches/jarpeek   # macOS; %LOCALAPPDATA%/jarpeek on Windows, ~/.cache/jarpeek elsewhere
```

## Credits

Decompilation ships [CFR](https://github.com/leibnitz27/cfr) 0.152 by Lee
Benfield (MIT); its license is included as `vendor/cfr-LICENSE.txt`.

## License

MIT — see [LICENSE](LICENSE).
