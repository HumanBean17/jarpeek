# jarpeek — Dependency Source Access for AI Agents on JVM Projects

**Status:** released

## Problem

AI coding agents (Claude Code, Codex CLI, Gemini CLI, Qwen Code, GigaCode) working on JVM
projects cannot read the source code of external dependencies. An agent that wants to read an
enum, a Spring Boot starter's implementation, or a method body from a library hits a wall:
`Read`/`Grep` only cover project files. Humans solved this decades ago with IDE
"cmd+click" navigation.

Agents are not humans: their context windows are limited, so "fetch the whole sources jar" is
not a solution. The tool must serve *structure first, fragments on demand*.

## Goal

A standalone tool, distributed via npm as `jarpeek`, that gives agents IDE-like navigation
into dependency sources through context-frugal primitives — with zero dependence on a running
IDE.

- **Scope**: any JVM project; v1 resolvers are Gradle and Maven; languages Java and Kotlin.
- **Platforms**: Windows, Linux, macOS — first-class and uniform.
- **Distribution**: one package, two faces — MCP server (stdio) and CLI — over a shared core.
- **Setup**: `jarpeek init` interactively wires the chosen harness (claude, codex, gemini,
  qwen, gigacode) in either MCP or CLI mode.
- **Agent self-description**: `jarpeek prime` injects the usage context into agent sessions.

## Research Conclusion: Reusing IntelliJ's Index

Direct reuse of an already-built IntelliJ index is not viable for a standalone tool:

- Index files live in the IDE system directory (macOS:
  `~/Library/Caches/JetBrains/IntelliJIdea<version>/`) in JetBrains' internal
  `PersistentHashMap` format — undocumented, hash-ID keyed, and changed between IDE releases.
  No official API reads them outside a running IDE.
- Headless IntelliJ Platform as an embedded library (the Qodana model) works but costs a full
  JVM boot and project import — disproportionate for "read me this enum".
- Talking to a *running* IDE via an MCP-exposing plugin
  (hechtcarmel/jetbrains-index-mcp-plugin model) is viable but requires the IDE open — it
  fails exactly where agents often run (CI, containers, headless boxes).

JVM projects do not need an IDE-grade index for this problem: dependency sources already sit
on disk as `-sources.jar` in `~/.gradle` / `~/.m2` caches, build tools can emit the exact
resolved classpath, `javap`-style signatures are derivable from class files, and CFR
decompiles the rest. **Decision: own lightweight index; IDE bridge reserved as a future
provider** (see Future Extensions).

## Hardened Dependency Policy (Locked Decision)

jarpeek must be as lightweight as possible and must work in strict enterprise conditions.
Only necessary dependencies may be a reason to fail.

- **Single delivery event**: everything a running jarpeek needs arrives with
  `npm install jarpeek` — including the CFR decompiler jar, bundled in the tarball. No
  runtime downloads, ever. Enterprise mirrors, offline npm caches, and vendored
  `node_modules` therefore cover installation completely.
- **Zero native modules**: no better-sqlite3, no tree-sitter native bindings — nothing that
  could require node-gyp, a compiler toolchain, or platform-specific prebuilds. Storage and
  parsing are own pure-TypeScript implementations.
- **No postinstall scripts**: nothing to compile or fetch at install time (also sidesteps
  enterprise policies that block npm lifecycle scripts).
- **Runtime requirements**: Node.js ≥ LTS. A JVM is required only for CFR decompilation;
  every other capability (indexing, outlines, signature reads, sourced reads) works without
  one. Both are guaranteed present for the target audience.
- **Allowed npm dependencies**: pure-JS only (MCP SDK, arg parsing) — arrived by the same
  install, no separate failure modes.

Consequences: parsing uses hand-written Java/Kotlin declaration lexers and the index is an
own plain-file format. Robustness tradeoffs are accepted knowingly (see Indexer) and
tree-sitter/SQLite remain possible future accelerators behind interfaces — never v1
requirements.

## Solution Overview

`jarpeek` resolves the project's real dependency set (build tool first, cache scan as
fallback), builds an artifact-level declaration index, and exposes a small declaration-centric
tool surface. Sources jars stay in the user cache; decompilation is per-class, on demand, and
cached. Every response is labeled with provenance so degraded answers self-describe.

Chosen foundation (from brainstorming):

- **Runtime**: Node/TypeScript, pure implementation, zero native modules.
- **Decompiler**: CFR, bundled in the npm package, invoked as `java -jar`.
- **Resolution**: build tool (Gradle + Maven) primary; cache scan fallback.
- **No-sources strategy**: layered — signatures for navigation, CFR decompile on read.
- **Parsing**: full declaration extraction for Java and Kotlin via own lexers.

## Architecture

```
┌─────────┐  ┌─────────┐
│ MCP stdio│  │   CLI   │      same core, 1:1 tool/command mapping
└────┬────┘  └────┬────┘
     └──────┬─────┘
      ┌─────▼──────┐
      │ query layer │  find_class · outline · read_member · read_source ·
      │             │  search_symbols · resolve/status/where + miss protocol
      ├─────────────┤
      │    index     │  own plain-file format: artifact-sharded declaration
      │             │  records + symbol directory, lazily loaded
      ├─────────────┤
      │   indexer    │  sources jars → own Java/Kotlin declaration lexers;
      │             │  binary jars → own class-file reader (signatures)
      ├─────────────┤
      │  resolvers   │  Gradle · Maven · JDK(src.zip) · CacheScan(fallback)
      ├─────────────┤
      │ decompiler   │  bundled CFR: per-class, on demand, cached
      └─────────────┘
```

The **declaration** is the universal unit: sourced, signature-only, and decompiled classes
expose identical `outline`/`read_member` behavior. Agents never meet a second-class artifact.

## Components

### Resolver layer

Pluggable resolvers emitting one shared **dependency graph**:

```json
{
  "coordinates": "org.springframework:spring-tx:6.1.4",
  "configuration": "runtimeClasspath",
  "kind": "external",
  "binaryJar": "~/.gradle/caches/.../spring-tx-6.1.4.jar",
  "sourcesJar": "~/.gradle/caches/.../spring-tx-6.1.4-sources.jar"
}
```

- **Gradle**: an init script installed under `.jarpeek/` (passed via `-I` only when jarpeek
  invokes Gradle — the user's build is never modified) registers one task that prints the
  resolved artifacts of all relevant configurations as JSON, using lenient resolution and
  requesting `sources`-classifier artifacts in the same pass. The wrapper (`gradlew` /
  `gradlew.bat`) is invoked per platform.
- **Maven**: resolver goals for classpath emission + sources download, driven by the
  *effective* resolution (nearest-wins conflict resolution, `dependencyManagement`/BOM
  overrides, activated profiles) rather than declared dependencies.
- **Configurations covered**: compile + runtime + test + annotationProcessor classpaths, each
  labeled in metadata.
- **Module deps**: sibling modules of a multi-module build resolve to their source
  directories (kind `module`), indexed in place so FQN→file lookup works across modules.
- **JDK**: a first-class pseudo-artifact `jdk:<version>` resolved from
  `$JAVA_HOME/lib/src.zip`; when absent, a one-time `jimage extract` of needed modules
  provides class files for signature extraction.
- **CacheScan (fallback)**: walks `~/.m2/repository` and Gradle's `modules-2` cache, pairing
  binary and sources jars per coordinate. Used when the build tool is missing or fails;
  results carry version-ambiguity warnings.

### Indexer and storage

Two-level storage:

- **Artifact-level index** (own plain-file format, OS-appropriate cache dir —
  e.g. `~/Library/Caches/jarpeek`, `~/.cache/jarpeek`, `%LOCALAPPDATA%\jarpeek`, overridable
  via `JARPEEK_CACHE_DIR`) keyed by `group:artifact:version`. Two projects sharing a
  dependency share its indexed records; re-indexing after a version bump touches only
  changed coordinates. Format: one NDJSON shard per artifact holding declaration records,
  plus a compact directory file mapping FQN → shard. Shards load lazily; symbol search
  streams over shards without loading everything into memory. The long-lived MCP process
  amortizes loads; one-shot CLI invocations pay only for the shards they touch.
- **Project manifest** (`.jarpeek/manifest.json`, gitignored) holding the resolved dependency
  list and the dependency-set hash (build files + lockfile mtimes).

Per-declaration record (conceptual shape):

```json
{
  "fqn": "org.springframework.transaction.interceptor.TransactionAspectSupport",
  "file": "org/springframework/transaction/interceptor/TransactionAspectSupport.java",
  "selector": "invokeWithinTransaction",
  "kind": "method",
  "visibility": "protected",
  "static": false,
  "deprecated": false,
  "signature": "protected Object invokeWithinTransaction(Method, Class<?>, InvocationCallback)",
  "lineStart": 402,
  "lineEnd": 512
}
```

- Sources jars are read through an own pure-TS zip central-directory reader (no `unzip`
  dependency, no full extraction) during indexing.
- Own Java and Kotlin declaration lexers (tokenizer + brace tracking) extract declarations;
  Kotlin file facades (`FooKt`) map to their `.kt` files; nested classes map to their
  containing file with a nested selector. Kotlin signatures preserve the modifiers that
  change meaning — `suspend`, `inline`, `reified` — and extension declarations carry their
  receiver type, since a coroutine-adjacent agent cannot reason without them; `expect` /
  `actual` declarations are captured and labeled as such (platform selection stays the
  reader's job). Lexer degradation is graceful by design: an exotic construct yields a
  missing member or an imprecise range, never a crash — and `read_source --full` still
  serves the raw file.
- Binary jars without sources are parsed by the own class-file reader (constant pool, access
  flags, generic `Signature` attributes) producing the same records minus line ranges.

### Query layer — agent-facing tool surface

Seven composable tools; the CLI mirrors them 1:1.

| Tool | Input | Output |
|---|---|---|
| `find_class` | name query (fuzzy, simple, or FQN) | candidate list: FQN, artifact, version, kind |
| `outline` | FQN, optional `kind` / `visibility` filters | declaration table: selector, kind, visibility, static, deprecated, signature |
| `read_member` | FQN + selector or selector list (`#a,#b,#c`) | per selector: javadoc + declaration source with original line numbers |
| `read_source` | FQN, explicit `--full` or `--lines a:b` | default = outline; whole file and raw slices only on explicit request |
| `read_resource` | artifact + entry path or glob (e.g. `META-INF/spring/*.imports`) | text entry contents with provenance |
| `search_symbols` | query | symbol matches across all indexed dependencies |
| `resolve` / `status` / `where` | — | re-resolve; index freshness; print unpacked sources cache dir for raw Grep |

Contracts:

- **Selector grammar**: `#name`, `#name(ParamType,...)`; Kotlin extension members may carry
  their receiver type for disambiguation (`#Foo.bar(...)`). A bare name with overloads
  returns all matching signatures and selectors — never a silent pick.
- **Batch reads**: `read_member` accepts a selector list in one call — reading ten members
  costs one round-trip, not ten.
- **Outline-first reads**: `read_source` defaults to an outline; full-file reads are explicit.
  Line-range reads are a subordinate escape hatch for sub-fragments already seen.
- **Resources are first-class**: `read_resource` serves any non-class jar entry —
  `META-INF/spring/*.imports`, `spring.factories`, `META-INF/services/*`, plugin descriptors,
  `*.kotlin_module` — as text with provenance. Framework configuration is where "what does
  this dependency actually do" starts, so it is readable without unpacking anything. Binary
  entries report their entry metadata and decline full content dumps.
- **Provenance** on every response: `source` | `decompiled` | `signature` — agents always
  know whether they read authoritative source or CFR's reconstruction.
- **FQN collisions**: duplicate classes across artifacts list the classpath-order winner plus
  all alternatives with coordinates.
- **Miss protocol** (in order): fuzzy candidates → JDK namespace routing → staleness
  re-resolve and retry → definitive negative listing the artifacts searched.
- **Lazy bootstrap**: the first tool call auto-resolves and indexes when no manifest exists —
  agents never run `init`; humans run it once.

### Decompiler adapter

CFR, pinned version, bundled inside the npm package. Decompile is per-class on `read_member`
against binary-only jars; output is re-lexed into the declaration model, so decompiled
classes expose the same member-level interface as sourced ones. Cache key:
`(coordinates, class, cfr-version)`.

### Transport

- **MCP**: stdio server built on the official TypeScript MCP SDK; tool schemas 1:1 with CLI.
- **CLI**: same commands as subcommands. Output contract: human-readable tables/markdown by
  default; `--json` emits exactly the MCP tool's structured payload, so Bash-driven agents
  get lossless machine-readable output.

### `prime` — agent self-description

`jarpeek prime` prints AI-optimized markdown describing what jarpeek is and how to use it
(the "before grepping for a class not in the repo, `find_class` first" rule plus the command
cheatsheet). It adapts to context: MCP mode emits a brief reminder (tool names only,
~50 tokens); CLI mode emits the full reference (~1–2k tokens). A `.jarpeek/PRIME.md` file
overrides the default content entirely. Flags mirror the established convention: `--full`
(force CLI output), `--mcp` (force minimal), `--export` (dump default content),
`--hook-json` (wrap output in the SessionStart hook JSON envelope consumed by Claude Code,
Gemini CLI, and Codex).

### Harness integration

A data-driven **descriptor table** — one implementation per schema family, rows per harness:

| Harness | MCP config | Instructions file | Hook |
|---|---|---|---|
| claude | `.mcp.json` (project) | `CLAUDE.md` | SessionStart |
| codex | `~/.codex/config.toml` `[mcp_servers]` | `AGENTS.md` | SessionStart |
| gemini | `.gemini/settings.json` `mcpServers` | `GEMINI.md` | SessionStart |
| qwen | `.qwen/settings.json` `mcpServers` | `QWEN.md` | SessionStart |
| gigacode | `.gigacode/settings.json` `mcpServers` | `GIGACODE.md` | SessionStart |

Qwen and GigaCode (a Qwen Code fork differing in `.qwen` → `.gigacode` and `QWEN.md` →
`GIGACODE.md`) share one parameterized implementation. A future harness or renamed fork is a
table row, not new code. Exact schemas are verified against each harness at implementation
time.

### `init` flow

1. Detect build system (Gradle KTS/Groovy, Maven, multi-module, mixed), JDK, existing harness configs.
2. Ask: harness (multi-select) → mode (mcp / cli).
3. Wire:
   - *MCP mode* — writes the harness's native MCP config.
   - *CLI mode* — registers a SessionStart hook running `jarpeek prime --hook-json`
     (context re-injected every session, compaction-proof) and appends a one-line pointer to
     the instructions file. No fat cheatsheet lives in the instruction files.
4. Also: gitignore `.jarpeek/`, install the Gradle init script, optionally run the first index.
5. Idempotent: re-runs detect and update, never duplicate.

## Cross-Platform

Windows, Linux, and macOS are first-class and uniform by construction: zero native modules
means no platform matrix to compile; all path handling goes through Node APIs with
platform-appropriate cache-dir resolution; the Gradle wrapper is invoked as `gradlew.bat` on
Windows; jar entry names are always `/`-separated and normalized on read. CI runs the full
test suite on all three OSes.

## Error Handling — Degradation Ladder

| Situation | Behavior |
|---|---|
| Build tool missing/fails | cache-scan resolution, provenance-labeled with version ambiguity warning |
| No sources jar | signatures immediately; CFR decompile per-class on read, cached |
| No `src.zip` | one-time jimage module extract for signatures |
| No JVM on PATH | everything except `read_member`-on-binary-only works; decompile request returns signatures + cause |
| Gradle re-resolve hangs | timeout → serve stale index with explicit staleness marker |
| Stale index detected | auto re-resolve → retry lookup → miss protocol |
| Lookup misses | miss protocol, ending in a definitive negative with evidence |
| Lexer hits exotic syntax | missing member or imprecise range, flagged; raw file still readable via `read_source --full` |
| Concurrent invocations | lockfile on cache dir; readers never blocked by stale writers |

Responses never lie: provenance and staleness fields make degraded answers self-describing.

## Testing

- **Unit**: lexer goldens over fixture jars pinned by coordinates; class-file reader diffed
  against `javap -p`; selector grammar table tests; miss-protocol state machine.
- **Integration**: in-repo fixture projects (Gradle single/multi-module, Kotlin DSL, Maven,
  one dependency deliberately without sources jar) → assert index records and tool outputs.
- **Contract/E2E**: MCP server driven in-process over stdio; golden transcripts per tool;
  **context-cost assertions** — e.g., `outline` of a known 1200-line class stays under a
  line budget (the product's core promise, tested as one).
- **Property**: every indexed declaration's slice is non-empty, in range, and its selector
  round-trips; malformed or exotic input never crashes a lexer.
- **Environment**: full suite on Windows/Linux/macOS; install test with `npm install
  --offline` from a vendored tarball (proves the hardened dependency policy); run with no JVM
  on PATH (proves graceful degradation).

## Non-Goals for v1 (Seams Reserved)

jarpeek is a **reading lens, not a navigation brain**. Its job is to let an agent read
dependency sources and resources in context-frugal fragments — everything below is
deliberately outside that thesis; agents needing these should use an IDE-grade tool.

- **Type hierarchy / find-implementations** — no `extends`/`implements` queries, no
  subtype/supertype navigation.
- **Annotation-aware or structural search** — `search_symbols` matches symbol names only.
- **Usage/reference index** — no find-usages, no call graphs, no who-calls-what.
- **Generated-source discovery** — annotation-processor output (`target/generated-sources`,
  `build/generated`) is not indexed; the running IDE remains the lens for generated code.
- **JDK decompilation** — with a stripped `src.zip`, JDK classes get signatures via the
  jimage fallback, not CFR output.
- **IDE bridge** — query layer hides behind a provider interface; a future provider proxies
  to a running IntelliJ (MCP-exposing plugin model) when present.
- **Remote artifact search** ("which Maven Central library has this class") — the miss
  protocol's terminal answer names this seam.
- **Parsing/index accelerators** (tree-sitter, SQLite) — possible future optimizations
  behind the lexer/index interfaces; never a requirement.
- sbt / mill / Leiningen resolvers; inherited members in outlines (declared only); write
  operations of any kind.

## v2 Milestone — Android

Android is out of v1 by scope decision, not by architecture: the resolver abstraction
absorbs it without redesign.

- **AndroidSdkResolver** — a JDK-style pseudo-artifact `android-sdk:platform:<api-level>`
  sourcing `$ANDROID_HOME/sources/android-<api>/` (detected via env or `local.properties`,
  platform resolved from `compileSdk`). `android.jar` is a stub jar and is never treated as
  source.
- **AAR support** — the own zip reader learns nested-jar reading (`classes.jar` and `libs/`
  inside `.aar`), reusing the existing binary-jar and sources-jar paths.
- **Configurations** — buildscript classpath plus variant configurations
  (`debugImplementation`, `releaseImplementation`, `kapt*`, `androidTest*`) join the init
  script's reported set.
- **Fixtures** — an AGP fixture project joins the integration suite.
- Still out even for v2: R8/ProGuard mapping retrace and `R`-class/resource indexing.

## Open Questions

1. **npm availability** — confirm `jarpeek` is free on npm and reserve the name.
2. **JDK selection** — which JDK to index when the build declares toolchains different from
   `JAVA_HOME` (prefer build-declared toolchain, fall back to `JAVA_HOME`)?
3. **Unpacked sources cache policy** — `where` exposes an unpacked cache for raw Grep; does
   it unpack eagerly per artifact (disk cost) or lazily per jar on first `where` call?
4. **CI cache placement** — with ephemeral `HOME`, should the cache default stay
  user-global (`JARPEEK_CACHE_DIR` for persistence) or should `init --ci` offer a
   project-local cache (`.jarpeek/cache`, shared across steps via the checked-out workspace)
   at the cost of re-indexing per clone?

## References

- hechtcarmel/jetbrains-index-mcp-plugin — IDE-side MCP exposure model (future provider)
- tangcent/maven-indexer-mcp — prior art, Maven-only subset of this problem
- CFR decompiler — benf.org/other/cfr
- `bd prime` — the adaptive self-description + `--hook-json` convention this design follows
