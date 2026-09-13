/**
 * The prime cheatsheets: what jarpeek is, phrased for the thing reading it.
 *
 * Two budgets, one rule. The mcp card is a sub-60-word handshake for tool
 * listings; the cli cheatsheet is the full markdown brief. Both lead with
 * the same rule — find-class answers "where does this class live" across
 * the project's own sources AND its dependencies in one call, so
 * grep-the-repo versus ask-jarpeek is never a decision the agent has to
 * make — and both state the lazy contract: the first query resolves,
 * nothing is ever indexed.
 */

/** The 9 MCP tool names, underscore forms (server.ts registers exactly these). */
export const MCP_TOOLS = [
  "find_class",
  "outline",
  "read_member",
  "read_source",
  "read_resource",
  "search_symbols",
  "resolve",
  "status",
  "where",
] as const;

/** The 9 CLI subcommands, dash forms (cli/index.ts registers exactly these). */
export const CLI_COMMANDS = [
  "find-class",
  "outline",
  "read-member",
  "read-source",
  "read-resource",
  "search-symbols",
  "resolve",
  "status",
  "where",
] as const;

export type PrimeMode = "mcp" | "cli";

/** The sub-60-word card for MCP wiring (init writes it into the tool listing). */
const MCP_CONTENT = [
  "jarpeek: lazy JVM source access — the project's own classes and its dependencies.",
  `tools: ${MCP_TOOLS.join(", ")}.`,
  "the first query auto-resolves dependencies — jarpeek never indexes;",
  "call find_class first, always: it covers your sources and dependencies.",
  "",
].join("\n");

/** The full markdown brief for CLI-first agents (600-1200 words). */
const CLI_CONTENT = `# jarpeek — JVM sources for agents: your project and its dependencies

jarpeek gives agents context-frugal access to JVM source code: the
project's own sources (Gradle/Maven build modules, resolved through the
build's own model) and its dependencies (Gradle and Maven artifacts, plus
the local JDK when it ships src.zip), resolved into a manifest of on-disk
backings. Nine commands answer "where does this class live, what does it
declare, and what does this member's code actually do?" — without
dumping whole files into context.

**Call find-class first, always — it covers the project's own sources and
its dependencies.** One call answers where the class lives; every hit
carries its origin (project, module, dependency, or jdk — cache when
resolution degrades to local machine caches), so "is this my code or a
library's?" is never a decision you have to make before navigating.
If it misses, the miss protocol below has already tried the recovery
steps for you.

## Resolution is lazy

Nothing needs to be started or configured by hand. The first query on a
fresh project — or the first query after the build files change —
auto-resolves the dependency set: one bounded Gradle/Maven pass that
rewrites \`.jarpeek/manifest.json\`. jarpeek never indexes; later queries
read the manifest and open only the jar entries they need. A resolve that
fails never fails the query: the command still answers, as a miss with the
failure's reason, and re-resolution backs off for 60 seconds so a broken
build is not re-run per query. \`resolve\` forces a re-resolve at any time;
\`status\` reports manifest freshness and JVM availability. All progress and
warnings go to stderr; stdout carries only the answer, so it stays
parseable.

## Commands

| command | input shape | returns |
| --- | --- | --- |
| \`find-class <query> [--limit n]\` | FQN, dot-suffix, simple name, or fuzzy name | class hits with artifact coordinates, origin (project / module / dependency / jdk), and provenance |
| \`outline <fqn> [--kind k] [--visibility v] [--minimal\|--full] [--no-imports] [--no-fields] [--no-methods] [--no-inner] [--no-javadoc] [--table]\` | one class | a java-shaped class skeleton: package, imports, javadoc, members as signature lines — \`--minimal\` keeps methods and nested classes only, \`--full\` renders javadoc blocks, \`--table\` opts into the legacy table |
| \`read-member <fqn> #name #name(T1,T2)\` | one class, several selectors at once | source slices for just those members, line-numbered |
| \`read-source <fqn> [--full] [--lines a:b]\` | one class | the whole file by default, numbered; \`--lines a:b\` for a range — outline and read-member are the frugal entry points before whole files |
| \`read-resource <artifact> <glob>\` | artifact + glob | non-class jar entries: configs, service descriptors, manifests |
| \`search-symbols <query> --artifact <g:a:v> [--limit n] [--kind k]\` | member name, scoped to one dependency artifact (the flag is required) | every declaration with that name in that artifact |
| \`resolve\` | — | force a re-resolve; rewrites the manifest; prints one line (count, duration) |
| \`status\` | — | manifest freshness and JVM availability report |
| \`where <coordinates>\` | one artifact | its recorded on-disk paths (sources jar, source roots, binary jar), each flagged exists or missing |

outline, read-member, and read-source serve project and module hits the
same way they serve dependencies — one navigation grammar everywhere.
search-symbols is the one exception: the ROOT project artifact is refused
with a pointer to your file tools (grep reaches your own repo natively),
while sibling module artifacts remain searchable like any dependency.

Artifact arguments take full \`g:a:v\` coordinates or a unique artifact id
(the \`a\` segment). In read-resource and where an unknown or ambiguous id is
a usage error naming the matches; search-symbols answers the same case as a
miss (step 2 below).

Add \`--json\` to any of the nine commands above for the machine-readable
result object — the exact payload the matching MCP tool returns (MCP names
are the underscore forms: find_class, outline, read_member, read_source,
read_resource, search_symbols, resolve, status, where). \`--project <dir>\`
picks the project root; the default is the current directory.

## Provenance

Every answer carries one of three provenance values, and they mean what you
are actually reading:

- \`source\` — the artifact ships a sources jar, or it is a project/module
  source root on disk. This is the real published (or authored) code.
- \`decompiled\` — no sources jar; jarpeek decompiled the bytecode with CFR
  on the local JVM. Faithful in structure, but local names, generics, and
  control flow are the compiler's reconstruction, not the author's
  spelling. Treat fine detail accordingly.
- \`signature\` — no sources and no decompilation (JVM unavailable or
  decompile disabled): declarations only. read-member answers "signature
  only" instead of code for these.

Degradations are reported, never hidden, and the answer still arrives: a
re-resolve that fails serves the existing manifest flagged \`stale\`; each
such condition is a \`warning: ...\` line on stderr.

## Miss protocol

A miss is an answer, not an error — the answer prints and the command
returns exit 0:

1. Suggestions. If the queried simple name matches a resolved class under
   another package, the miss returns those candidates ("did you mean ...").
2. Artifact did-you-mean. An unknown artifact in search-symbols answers
   with the closest resolved artifact ids.
3. Negative. Otherwise the miss reports exactly which artifacts were
   searched — the project's own sources and every resolved dependency —
   and that remote artifact search is a planned extension. A miss
   certifies the class is nowhere in the project or its resolved
   dependencies: stop and ask the user instead of guessing.

Only malformed selectors, unreadable IO, and usage errors exit 1.

## Overrides

A \`.jarpeek/PRIME.md\` in the project replaces this cheatsheet verbatim for
every mode; \`--export\` bypasses it and prints this file.

full content: jarpeek prime --export
`;

/** The cheatsheet for a mode. */
export function defaultPrimeContent(mode: PrimeMode): string {
  return mode === "mcp" ? MCP_CONTENT : CLI_CONTENT;
}
