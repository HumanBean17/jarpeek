# jarpeek

[![npm](https://img.shields.io/npm/v/jarpeek)](https://www.npmjs.com/package/jarpeek)
[![CI](https://github.com/HumanBean17/jarpeek/actions/workflows/ci.yml/badge.svg)](https://github.com/HumanBean17/jarpeek/actions/workflows/ci.yml)

Context-frugal navigation into JVM dependency sources, for AI agents.

## Why

An agent working on a Gradle or Maven project that needs to know what
`SomeLibraryClient.builder()` actually does has bad options: read a
decompiled 3,000-line file whole (context gone), grep the binary jar
(noise), or guess from a doc page (hallucination risk). jarpeek gives the
agent the same navigation a human has in an IDE — find the class, see its
members, read exactly the method body asked for — at a fraction of the
token cost.

## How it works

- **Lazy, no index.** The first query on a fresh project (or after the
  build files change) runs one bounded Gradle/Maven resolve and writes a
  manifest of the on-disk jars. That is all the up-front work there is;
  every later query reads the manifest and opens only the jar entries it
  needs.
- **One-file parses.** A class lookup parses just the winning artifact's
  entry for that class — one source entry or class file, never the jar
  around it.
- **Skeleton outlines.** `outline` renders a Java-shaped skeleton —
  package, imports, javadoc, members as code lines — with
  `--minimal`/`--full` presets and per-section toggles; `read-source`
  serves the whole file, `read-member` returns only the requested method
  spans.
- **Provenance on everything.** Every answer says whether it is `source`,
  `decompiled`, or `signature` — so the agent knows what it is reading.
- **Misses are answers.** Unknown classes return suggestions and searched
  artifacts with exit code 0, never a stack trace.
- **Quiet by contract.** stderr is capped at three lines per invocation;
  stdout stays parseable.

jarpeek resolves through the project's own build (Gradle, then Maven,
then local machine caches as an explicit last resort), appends the local
JDK when it ships sources, and decompiles on demand with a bundled CFR.
It speaks MCP (a stdio subprocess, for harnesses that support it) and a
plain CLI (for everything else).

The design rationale — why lazy instead of an index, the resolve cascade,
the degradation rules — is in the [design notes](docs/design.md).

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
| `outline` | `fqn`, `kind?`, `visibility?`, `preset?`, `sections?` | The class skeleton's declaration rows — the frugal first look |
| `read_member` | `fqn`, `selectors[]` | Source slices for the named members |
| `read_source` | `fqn`, `mode?` (`full`\|`lines`\|`outline`), `from?`, `to?` | Source text for one class — full by default; prefer outline |
| `read_resource` | `artifact`, `glob` | Non-class jar entries (config, services, manifests) |
| `search_symbols` | `query`, `artifact` (required), `limit?`, `kind?` | Declarations by member name in one artifact |
| `resolve` | — | Forced re-resolve; one summary line (count, duration, warnings), plus the warnings when any |
| `status` | — | Manifest freshness (present, resolvedAt, stale, artifactCount) and JVM report |
| `where` | `coordinates` | The artifact's recorded on-disk paths, each flagged exists or missing |

Artifact arguments take full `g:a:v` coordinates or a unique artifact id
(the `a` segment).

### Resolution is lazy

Nothing needs to be primed by hand. The first query on a fresh project —
or after the build files change or a recorded jar vanishes —
auto-resolves: one bounded Gradle/Maven pass, one stderr notice line
(plus a 30s heartbeat while it runs), and the manifest is rewritten.
Resolves run the system `mvn`/`gradle` from PATH first, the project's
root wrapper as fallback — including a retry after a failed system run —
so a CI-only wrapper never blocks local use (see `--build-tool`).

A resolve that fails never fails the query: with a manifest on disk it is
served flagged `stale` with a warning; without one the query answers as a
miss, and re-resolution backs off for 60 seconds so a broken build is not
re-run per query. `jarpeek resolve` re-runs the cascade on demand and
reports the failure. The full cascade and degradation rules are in the
[design notes](docs/design.md).

### CLI

Every tool is also a dash-named subcommand; `--json` prints the exact MCP
result object, `--project <dir>` picks the project root (default: cwd).
Member selectors are `#name` or `#name(Type,...)` for overloads.

```
jarpeek --json find-class StringJoiner --limit 5
jarpeek outline java.util.StringJoiner --kind method
jarpeek outline java.util.StringJoiner --minimal
jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'
jarpeek read-source com.example.lib.ApiClient --lines 40:80
jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'
jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method
jarpeek resolve
jarpeek status
jarpeek where com.example:demo-lib:1.0.0
```

`search-symbols` without `--artifact` is a usage error.

Also: `jarpeek init` (wire harnesses), `jarpeek prime` (print the agent
cheatsheet; `--full`, `--mcp`, `--export`, `--hook-json`), `jarpeek mcp`
(serve MCP stdio).

Diagnostics — the one bootstrap notice, resolve heartbeats, warnings,
degradations — go to stderr (warnings under a three-line cap); stdout
stays parseable. Unknown classes exit 0 with suggestions.

## Provenance

Every answer carries one of three provenance values, computed for that
answer rather than stored anywhere:

- `source` — the artifact ships a sources jar (or module source dir). The
  real published code — and the only provenance whose outlines carry
  imports and javadoc (class files have neither).
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

Degradations are reported, never hidden, and the answer still arrives:
each is a `warning: ...` line on stderr (a `degraded[]` field in JSON),
aggregated under the three-line warning budget. Search results are scoped
to the project's resolved dependency set, and `search_symbols` further to
the one named artifact.

## Configuration

| Knob | Meaning |
| --- | --- |
| `--build-tool <auto\|system\|wrapper>` | CLI global flag (all subcommands incl. `mcp`): which mvn/gradle runs resolves (`auto` = system first, wrapper fallback) |
| `JARPEEK_BUILD_TOOL` | Same tri-state via environment; beats config, loses to the flag — the layer to use for harness-spawned MCP servers without server args |
| `JARPEEK_M2_DIR` / `M2_REPO` | Where the Maven local repository lives; steers both the Maven resolver's anchor and the cache scan |
| `JARPEEK_GRADLE_CACHE_DIR` / `GRADLE_USER_HOME` | Where the Gradle modules-2 cache lives (`GRADLE_USER_HOME` is the cache's parent — the scan walks `<it>/caches/modules-2/files-2.1`) |
| `JARPEEK_HOME` | Override the home directory used for user-scoped harness configs and the global config below |
| `JARPEEK_PRIME_MODE` | Default `prime` mode (`cli` or `mcp`) when config is absent |
| `.jarpeek/PRIME.md` | Replaces the agent cheatsheet verbatim, every mode |
| `.jarpeek/config.json` | Written by `init`; records the wired `primeMode`; `buildTool` is hand-added, `m2Dir`/`gradleCacheDir` are pinned by `init`'s advanced step (or by hand) — persistent defaults |
| `~/.config/jarpeek/config.json` | Machine-wide defaults: the same `m2Dir` / `gradleCacheDir` fields, read when the project config names none |

Cache roots converge in a fixed order — explicit env var, project config,
global config, maven's `settings.xml` `<localRepository>` (m2 only), then
the default `~/.m2/repository` — and env beats config, like `buildTool`:
both are hand-authored machine facts a one-off shell override should win
against. `init` shows the detected roots and persists only an explicit
override. Nothing to configure still works: when no candidate matches
mvn's classpath output, the resolver derives the repository root from the
output itself (quorum-guaranteed) and says so with a
`maven: m2-anchor-derived:<path>` warning; `jarpeek status` prints the
effective roots and the layer each came from.

Flipping the build-tool setting or the m2 root re-resolves: both are part
of the manifest fingerprint, so a manifest produced by the other tool —
or anchored at another repository — is never served as fresh.

`.jarpeek/` is per-machine state (the manifest, prime config) — gitignore
it (`init` adds it). The manifest is the only derived state jarpeek ever
writes to disk; 0.1-era caches are unused and safe to delete (see the
[design notes](docs/design.md#migrating-from-01x)).

## Limitations

- No type hierarchy, find-usages, or call-graph navigation — declaration
  lookup and source reads only.
- Member-name search is scoped to one artifact (`search_symbols` requires
  its `artifact` argument).
- JDK classes need `$JAVA_HOME/lib/src.zip` — there is no jimage
  fallback. Without it, JDK classes are unavailable.
- Source-jar FQNs are derived from entry paths: a jar whose entries
  mismatch its declared packages can misreport a class's location.
- No generated-source awareness (protobuf, Dagger): generated classes
  appear only if they land in the resolved artifacts.
- No remote artifact search (Maven Central by coordinates): on a miss,
  jarpeek reports what it searched and stops rather than fetching.
- Maven SNAPSHOT dependencies resolved to timestamped jars
  (`artifact-1.0-20240501.123456-3.jar`) are not recognized by the Maven
  resolver's m2-layout matching and are skipped.
- Decompilation quality is CFR's; `signature` is the floor when no JVM is
  available.

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

### Releasing

CI runs on pushes to `main` and on PRs; releases are tag-driven. To cut
one:

```
npm version minor        # bump commit + v* tag (patch | minor | major)
git push --follow-tags   # the release workflow takes over
```

The workflow verifies the tag matches `package.json`, reruns every gate,
publishes to npm with provenance via [trusted publishing][tp] — no tokens
stored in the repo — and opens a GitHub Release with notes grouped from
conventional commits.

One-time setup: on npmjs.com, list this repository and `release.yml` as a
trusted publisher for the `jarpeek` package.

[tp]: https://docs.npmjs.com/trusted-publishers/

## Credits

Decompilation ships [CFR](https://github.com/leibnitz27/cfr) 0.152 by Lee
Benfield (MIT); its license is included as `vendor/cfr-LICENSE.txt`.

## License

MIT — see [LICENSE](LICENSE).
