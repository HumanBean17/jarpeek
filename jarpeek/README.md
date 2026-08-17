# jarpeek

Context-frugal navigation into JVM dependency sources, for AI agents.

## Why

An agent working on a Gradle or Maven project that needs to know what
`SomeLibraryClient.builder()` actually does has bad options: read a
decompiled 3,000-line file whole (context gone), grep the binary jar
(noise), or guess from a doc page (hallucination risk). jarpeek gives the
agent the same navigation a human has in an IDE — find the class, see its
members, read exactly the method body asked for — at a fraction of the
token cost:

- **Outline first.** Declaration tables before source text; `read-source`
  defaults to an outline, `read-member` returns only the requested method
  spans.
- **Provenance on everything.** Every answer says whether it is `source`,
  `decompiled`, or `signature`, so the agent knows what it is reading.
- **Misses are answers.** Unknown classes return suggestions and searched
  artifacts with exit code 0, never a stack trace.

jarpeek resolves the project's dependency set once (Gradle, Maven, local
caches, the JDK), indexes declarations from sources jars and bytecode, and
decompiles on demand with a bundled CFR. It speaks MCP (in-process, for
harnesses that support it) and a plain CLI (for everything else).

## Install

```
npm install -g jarpeek
jarpeek init
```

`init` detects the build system, wires the MCP server or CLI hints into
your AI harness (Claude Code, Codex, Gemini CLI, Qwen Code, GigaCode), and
runs the first index. `--yes` takes the non-interactive defaults (Claude
Code + MCP, skip the first index).

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
| `search_symbols` | `query`, `limit?`, `kind?` | Declarations by member name across artifacts |
| `resolve` | — | Force a resolve + index pass |
| `status` | — | Manifest, index, and JVM report |
| `where` | `coordinates` | On-disk sources for one artifact |

### CLI

Every tool is also a dash-named subcommand; `--json` prints the exact MCP
result object, `--project <dir>` picks the project root (default: cwd).
Member selectors are `#name` or `#name(Type,...)` for overloads.

```
jarpeek --json find-class StringJoiner --limit 5
jarpeek outline java.util.StringJoiner --kind method
jarpeek read-member com.example.lib.ApiClient #execute(Request,int)
jarpeek read-source com.example.lib.ApiClient --lines 40:80
jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'
jarpeek search-symbols builder --kind method
jarpeek resolve
jarpeek status
jarpeek where com.example:demo-lib:1.0.0
```

Also: `jarpeek init` (wire harnesses), `jarpeek prime` (print the agent
cheatsheet; `--full`, `--mcp`, `--export`, `--hook-json`), `jarpeek mcp`
(serve MCP stdio).

Diagnostics — bootstrap progress, warnings, degradations — go to stderr;
stdout stays parseable. Unknown classes exit 0 with suggestions.

## Provenance

Every answer carries one of three provenance values:

- `source` — the artifact ships a sources jar (or module source dir). The
  real published code.
- `decompiled` — no sources jar; bytecode decompiled with the bundled CFR.
  Faithful in structure, but local names, generics, and control flow are
  the compiler's reconstruction. Treat fine detail accordingly.
- `signature` — no sources and no decompilation (JVM unavailable, JDK
  classes, or decompile disabled): declarations only. `read-member` answers
  "signature only" instead of code.

Degradations are reported, never hidden, and the answer still arrives:
build resolution that fails falls back to local machine caches
(cache-scan); a failed re-resolve serves the stale index flagged `stale`.
Each is a `warning: ...` line on stderr (a `degraded[]` field in JSON).
Search results are scoped to the project's resolved dependency set —
shards in the machine-wide cache that the manifest does not list (other
projects' artifacts, stale versions of bumped dependencies) are excluded,
and a lookup answered only by such a shard is flagged `artifact no longer
in dependency set`.

## Configuration

| Knob | Meaning |
| --- | --- |
| `JARPEEK_CACHE_DIR` | Override the index/cache directory (default: platform cache dir) |
| `JARPEEK_HOME` | Override the home directory used for user-scoped harness configs |
| `JARPEEK_PRIME_MODE` | Default `prime` mode (`cli` or `mcp`) when config is absent |
| `.jarpeek/PRIME.md` | Replaces the agent cheatsheet verbatim, every mode |
| `.jarpeek/config.json` | Written by `init`; records the wired `primeMode` |

`.jarpeek/` is per-machine state (manifest, caches) — gitignore it.

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
- No generated-source awareness (protobuf, Dagger): generated classes are
  indexed only if they land in the resolved artifacts.
- Remote artifact search (Maven Central by coordinates) is a planned
  extension, not a feature: on a miss, jarpeek reports what it searched and
  stops rather than fetching.
- Maven SNAPSHOT dependencies resolved to timestamped jars
  (`artifact-1.0-20240501.123456-3.jar`) are not recognized by the Maven
  resolver's m2-layout matching and are skipped.
- Decompilation quality is CFR's; `signature` is the floor when no JVM is
  available.

## License

MIT — see [LICENSE](LICENSE).
