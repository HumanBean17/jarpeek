/**
 * The prime cheatsheets: what jarpeek is, phrased for the thing reading it.
 *
 * Two budgets, one rule. The mcp card is a sub-60-word handshake for tool
 * listings; the cli cheatsheet is the full markdown brief. Both lead with the
 * same rule — an agent's default reflex for external classes is grepping the
 * repo, and that reflex finds nothing, because dependencies are not in the
 * repo — and both state the lazy contract: the first query resolves, nothing
 * is ever indexed.
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
  "jarpeek: lazy access to JVM dependency sources (classes, members, resources).",
  `tools: ${MCP_TOOLS.join(", ")}.`,
  "the first query auto-resolves dependencies — jarpeek never indexes;",
  "before grepping the repo for an external class, call find_class first.",
  "",
].join("\n");

/** The full markdown brief for CLI-first agents (600-1200 words). */
const CLI_CONTENT = `# jarpeek — dependency sources for JVM projects

jarpeek gives agents context-frugal access to the source code of a JVM
project's dependencies: Gradle and Maven artifacts (plus the local JDK when
it ships src.zip) are resolved into a manifest of on-disk jars, and nine
commands answer "which artifact has this class, what does it declare, and
what does this member's code actually do?" — without vendoring sources into
the repo or dumping whole files into context.

**Before grepping the repo for an external class, call find-class first.**
Dependencies are not in your repo — grep cannot see them. find-class answers
from the resolved artifact set in one call, and if it misses, the miss
protocol below has already tried the recovery steps for you.

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
| \`find-class <query> [--limit n]\` | FQN, dot-suffix, simple name, or fuzzy name | class hits with artifact coordinates and provenance |
| \`outline <fqn> [--kind k] [--visibility v]\` | one class | declaration rows — name, kind, visibility, static, signature — no source text |
| \`read-member <fqn> #name #name(T1,T2)\` | one class, several selectors at once | source slices for just those members, line-numbered |
| \`read-source <fqn> [--full] [--lines a:b]\` | one class | outline by default; whole file or a line range on request |
| \`read-resource <artifact> <glob>\` | artifact + glob | non-class jar entries: configs, service descriptors, manifests |
| \`search-symbols <query> --artifact <g:a:v> [--limit n] [--kind k]\` | member name, scoped to one artifact (the flag is required) | every declaration with that name in that artifact |
| \`resolve\` | — | force a re-resolve; rewrites the manifest; prints one line (count, duration) |
| \`status\` | — | manifest freshness and JVM availability report |
| \`where <coordinates>\` | one artifact | its recorded on-disk paths (sources jar, source dir, binary jar), each flagged exists or missing |

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

- \`source\` — the artifact ships a sources jar (or a module source dir).
  This is the real published code.
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
   searched and that remote artifact search is a planned extension — stop
   and ask the user instead of guessing.

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
