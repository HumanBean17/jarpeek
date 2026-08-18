/**
 * The prime cheatsheets: what jarpeek is, phrased for the thing reading it.
 *
 * Two budgets, one rule. The mcp card is a sub-60-word handshake for tool
 * listings; the cli cheatsheet is the full markdown brief. Both lead with the
 * same rule — an agent's default reflex for external classes is grepping the
 * repo, and that reflex finds nothing, because dependencies are not in the
 * repo.
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
  "jarpeek: indexed access to JVM dependency sources (classes, members, resources).",
  `tools: ${MCP_TOOLS.join(", ")}.`,
  "before grepping the repo for an external class, call find_class first.",
  "",
].join("\n");

/** The full markdown brief for CLI-first agents (600-1200 words). */
const CLI_CONTENT = `# jarpeek — dependency sources for JVM projects

jarpeek gives agents context-frugal access to the source code of a JVM
project's dependencies: Gradle, Maven, and JDK artifacts are resolved once,
indexed into declarations, and served through nine commands that answer
"which artifact has this class, what does it declare, and what does this
member's code actually do?" — without vendoring sources into the repo or
dumping whole files into context. Nothing needs to be started or configured
by hand: the first query bootstraps resolve + index automatically, later
queries serve the manifest-checked index, and a changed build file
re-resolves on the next miss. All progress and warnings go to stderr; stdout
carries only the answer, so it stays parseable.

**Before grepping the repo for an external class, call find-class first.**
Dependencies are not in your repo — grep cannot see them. find-class answers
from the indexed artifact set in one call, and if it misses, the miss
protocol below has already tried the three recovery steps for you.

## Commands

| command | input shape | returns |
| --- | --- | --- |
| \`find-class <query> [--limit n]\` | FQN, dot-suffix, simple name, or fuzzy name | class hits with artifact coordinates and provenance |
| \`outline <fqn> [--kind k] [--visibility v]\` | one class | declaration rows — name, kind, visibility, static, signature — no source text |
| \`read-member <fqn> <selectors...>\` | \`#name\` or \`#name(T1,T2)\`, several at once | source slices for just those members, line-numbered |
| \`read-source <fqn> [--full] [--lines a:b]\` | one class | outline by default; whole file or a line range on request |
| \`read-resource <artifact> <glob>\` | artifact + glob | non-class jar entries: configs, service descriptors, manifests |
| \`search-symbols <query> [--limit n] [--kind k]\` | member name | every declaration with that name across artifacts |
| \`resolve\` | — | force a resolve + index pass; reports indexed vs skipped |
| \`status\` | — | manifest freshness and JVM availability report |
| \`where <coordinates>\` | one artifact | its recorded on-disk paths (jar, sources, source dir) with existence |

Add \`--json\` to any of the nine query commands above for the
machine-readable result object — the exact payload the matching MCP tool
returns (MCP names are the underscore forms: find_class, outline,
read_member, read_source, read_resource, search_symbols, resolve, status,
where). \`--project <dir>\` picks the project root; the default is the
current directory.

## Provenance

Every answer carries one of three provenance values, and they mean what you
are actually reading:

- \`source\` — the artifact ships a sources jar (or a module source dir).
  This is the real published code.
- \`decompiled\` — no sources jar; jarpeek decompiled the bytecode with CFR.
  Faithful in structure, but local names, generics, and control flow are the
  compiler's reconstruction, not the author's spelling. Treat fine detail
  accordingly.
- \`signature\` — no sources and no decompilation (JVM unavailable or
  decompile disabled): declarations only. read-member answers "signature
  only" instead of code for these.

Degradations are reported, never hidden, and the answer still arrives:
Gradle resolution that fails falls back to local machine caches
(cache-scan); a failed re-resolve serves the stale index flagged \`stale\`;
each such condition is a \`warning: ...\` line on stderr.

## Miss protocol

A miss is an answer, not an error — the command still exits 0:

1. Suggestions. If the queried simple name matches an indexed class under
   another package, the miss returns those candidates ("did you mean ...").
2. JDK routing. Names in \`java.*\`, \`javax.*\`, \`jdk.*\`, \`sun.*\`,
   \`org.w3c.dom.*\`, \`org.xml.sax.*\`, \`org.ietf.jgss.*\` trigger JDK
   indexing, then one retry.
3. Staleness. A manifest made stale by a changed build file re-resolves and
   retries once.
4. Negative. Otherwise the miss reports exactly which artifacts were
   searched and that remote artifact search is a planned extension — stop
   and ask the user instead of guessing.

## Overrides

A \`.jarpeek/PRIME.md\` in the project replaces this cheatsheet verbatim for
every mode; \`--export\` bypasses it and prints this file.

full content: jarpeek prime --export
`;

/** The cheatsheet for a mode. */
export function defaultPrimeContent(mode: PrimeMode): string {
  return mode === "mcp" ? MCP_CONTENT : CLI_CONTENT;
}
