# jarpeek design notes

Why jarpeek works the way it does: the 0.1 failure, the lazy redesign,
and the contracts that came out of it. For what the tools do day to day,
read the [README](../README.md).

## The universal locator (the project is an artifact too)

jarpeek's identity is "JVM class navigation", not "dependency
navigation": `find_class` answers "where does this class live" across the
project's **own sources and its dependencies** in one call, every hit
carrying its `origin` (`project`, `module`, `dependency`, `jdk`, `cache`).
The problem it removes is a decision agents were burning turns on — "is
this class mine (grep the repo) or a dependency's (grep cannot see it)?"
— and the steering contract that follows: *find_class first, always*.

The mechanism is the same one dependencies use, extended by one question:
resolvers always asked the build "what is on the classpath?", and a
project's own sources are never on its own classpath — so the Gradle init
script now also dumps every build project's sourceSets roots (root
included, subsuming the old dependency-only module discovery), and the
Maven resolver reads the pom model (`<sourceDirectory>` /
`<testSourceDirectory>`, declared `<modules>` followed recursively,
conventional Kotlin roots when they exist on disk). The root module
enters the manifest as a `kind: "project"` artifact, sibling modules as
`kind: "module"`, each on package roots (`sourceDirs`) walked live at
query time — which also fixes module fqns, previously prefixed by their
walk-relative path (`src.main.java.…`) because modules were walked from
the whole project directory.

Consequences held deliberately:

- **Same failure domain.** The project half answers exactly when the
  dependency half does — a broken build on a fresh project is a miss,
  not a partial answer that reads as complete. (One exception by
  structure: a Maven dependency-less project whose build ran clean
  resolves to its own modules with an empty classpath — that is a
  complete answer, not a degradation; an empty classpath from a FAILING
  build stays a failure and keeps the cascade.)
- **Cache-scan stays project-blind** — the explicit last resort has no
  build tool to ask.
- **`search_symbols` refuses the root project artifact** ("project
  sources: grep") — the agent's file tools reach its own repo natively,
  and scanning a whole project's declarations per query is the 0.1
  failure in miniature. Sibling modules remain searchable (pre-existing
  precedent).
- **Shadowing is honest.** The same FQN in project and dependency
  returns both hits, project first: match-quality tiers still lead, with
  origin as the tiebreak inside a tier (project → module → dependency →
  jdk → cache), so the code that shadows outranks the code shadowed —
  and the library original stays visible for the debugging that needs it.
- **Read parity is total.** outline/read-member/read-source serve
  project hits through the same sourceDir machinery modules use — one
  navigation grammar everywhere.
- **Known misses.** Maven custom Kotlin source dirs outside
  `src/{main,test}/kotlin`, and unresolvable `${...}` pom source dirs,
  fall back to the conventional roots; Gradle projects whose sourceSets
  the dump cannot read contribute nothing rather than failing the dump.
  A build module whose declared roots are ALL absent on disk (the
  standard source-less Maven aggregator root) records no artifact: an
  all-absent artifact would wedge staleness into re-resolving every
  query, since a successful resolve never clears it. Modules with at
  least one live root keep their declared-but-absent roots — a test tree
  that appears later needs no re-resolve.
- Manifest layout v3 carries the new fields; every v2 manifest reads as
  stale exactly once (the version check rejects it), so upgraders
  re-resolve on their first query.

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
  through in-memory zip listings — cached per stamp, so a rebuilt jar
  re-lists while an untouched one costs one stat. Source-root listings
  are the exception that re-walks on every call: these are the trees an
  agent edits mid-session, and a cached listing would miss a class added
  seconds ago. Directory walks are the cheap part; the walk itself
  derives the stamp (per-file stats in sorted relpath order), so an
  unchanged tree keeps a stable stamp and the parse memo keyed on it
  survives. The manifest is the only derived state on disk.
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
`buildTool` knob (precedence in that order — env beats config
deliberately, unlike init-written `primeMode`, because `buildTool` is
hand-authored state a shell override should win against) forces a
direction; the effective strategy is part of the manifest fingerprint, so
flipping it re-resolves instead of serving the other tool's manifest —
and manifests written before the strategy line existed hash stale once,
so every upgrading user re-resolves on their first query. The explicit
`jarpeek resolve` command keeps the full cascade and is the only writer
of a cache-scan-flagged manifest; **queries never adopt a cache-scan
manifest** — with a manifest on disk they are served from it, without
one they answer as a miss.

Cache roots converge through the same shape (`roots.ts`): an ordered
candidate list — `JARPEEK_M2_DIR`, `M2_REPO`, the project config's
`m2Dir`, the machine-wide `~/.config/jarpeek/config.json`, maven's own
`settings.xml` `<localRepository>`, then the default `~/.m2/repository`
— with env beating config for the same hand-authored-machine-fact
reason. The gradle side is a single root, not a list:
`JARPEEK_GRADLE_CACHE_DIR`, then the `GRADLE_USER_HOME`-derived
`caches/modules-2/files-2.1`, then the two configs, then the default.
The Maven resolver anchors each classpath entry against every candidate
(a classpath spanning several roots parses completely); when no entry
anchors anywhere, it derives the root from mvn's own output — each
layout-shaped entry proposes its repository-named path boundaries, the
boundary backed by the most distinct entries wins at a quorum of two,
and a root too blandly named to recognize refuses derivation outright,
preserving the loud `classpath-not-in-m2-layout` failure rather than
guessing coordinates — and a successful derivation carries
`m2-anchor-derived:<path>` as a warning, so a relocated repository
resolves correctly even with nothing configured instead of degrading
into a whole-directory cache scan (GH#12). The cache scan walks the
convergence's primary m2 root. The primary root joins the manifest
fingerprint beside the strategy, with the same re-resolve-on-flip and
one-time-stale-for-upgraders consequences; `status` reports both roots
with the layer each came from.

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

## Localization (the `--lang` boundary)

Human-mode CLI output localizes (Russian ships first: `--lang ru` or a
`language` field in `.jarpeek/config.json`; flag beats config, default
English). Everything an agent or a script consumes does not: `--json`
output, the MCP server, the `prime` cheatsheet, and every string produced
by core/resolver (degradation warnings, miss notes and reasons) stay
English — they are contract surface, not prose. The same rule splits the
human surface itself: sentences translate, schema-shaped tokens stay
verbatim in both locales (command/flag names, FQNs, coordinates, table
column headers, enum-ish cell values) — a translated header over
untranslated cells would read as mixed language.

Mechanics: typed message catalogs in `src/cli/i18n/` — the English catalog
is the source of truth, every locale is `Catalog = typeof en`, so the
compiler rejects a partial translation (no runtime fallback machinery).
Plurals go through `Intl.PluralRules` (Russian one/few/many). Because
commander builds the program — descriptions, option help, help blocks —
before parsing, build-time strings converge on a raw-argv pre-scan of
`--lang`/`--project`; runtime actions re-resolve through the parsed
options, so a trailing `--lang ru` localizes everything rendered after
the parse (the one exception: flag-coercion errors, which fire at parse
time and use the pre-scan locale).

## Gone by design

- **No index, ever.** The manifest is the only derived state jarpeek
  writes to disk.
- **No global member-name search.** `search_symbols` is scoped to one
  artifact and its `artifact` argument is required — and the project
  artifact is refused outright (grep is the tool for the agent's own
  repo) — because scanning ~100,000 declarations per query is the 0.1
  failure in miniature.
- **No remote artifact search.** Maven Central lookup by coordinates is
  a planned extension, not a feature: on a miss, jarpeek reports what it
  searched and stops rather than fetching.

## Dependency floors

Users sit behind registry mirrors that lag npm by months — jarpeek met
that as an install failure, because it demanded a then-one-month-old MCP
SDK. The floors exist to make the oldest installable pair a tested
contract, not a hope:

- `@modelcontextprotocol/sdk ^1.21.0` — the registerTool API jarpeek
  speaks was complete by 1.12, but 1.21 is where invalid tool arguments
  started answering as a tool error (`isError: true`) instead of a
  protocol-level rejection; that behavior is asserted by the
  `search_symbols` schema test and is the real floor. The SDK's 2.x line
  ships under new scoped package names, so `^1` can never resolve into
  a breaking upgrade.
- `zod ^3.25.1 || ^4.0.0` — declared because `src/mcp/server.ts`
  imports it directly; before this it resolved only as a hoisted
  transitive of the SDK. The range intersects every SDK in `^1.21` so
  npm always dedupes to a single zod instance (3.25.x with older SDKs,
  4.x with 1.23+). `.1` skips 3.25.0 — a publish whose tarball shipped
  no `dist/` at all. Dev pins older than 3.25.76 hit TS2589
  ("type instantiation is excessively deep") under pre-1.23 SDK types.
- CI (`floor-compat` job) installs exactly `sdk@1.21.0 + zod@3.25.76`
  and runs the full suite — the golden-pinned MCP contract is proven at
  both ends of the range on every push. The pins are kept in sync with
  the manifest floors by hand.

## Migrating from 0.1.x

0.2.0 was breaking: the eager index and its cache are gone. A v1
`.jarpeek` manifest is not read — the first query re-resolves and
rewrites it automatically. Old caches are unused and safe to delete:

    rm -rf ~/Library/Caches/jarpeek   # macOS; %LOCALAPPDATA%/jarpeek on Windows, ~/.cache/jarpeek elsewhere
