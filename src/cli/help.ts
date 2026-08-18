/**
 * The appended help blocks: what a cold agent reads before its first call.
 *
 * Contract per block: a leading blank line (commander appends under its
 * default output), an `Examples:` section of copy-pasteable invocations
 * with realistic arguments, and one `related:` cross-link naming the
 * cheaper or neighboring command. Enum value lists are deliberately
 * absent — commander auto-renders declared flag choices into the options
 * table, so the values an agent sees are the same ones validation enforces
 * and the MCP schema accepts; hand-copying them here is how they would
 * drift.
 */

/** Appended to `jarpeek --help`: the decision guidance and the way out. */
export const TOP_LEVEL_HELP = `
the frugal path: find-class to locate the class, outline for its shape, read-member for exactly the member's code — read-source only when you need the whole file.

Examples:
  jarpeek find-class StringJoiner --limit 5
  jarpeek outline java.util.StringJoiner --kind method
  jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'
  jarpeek read-source com.example.lib.ApiClient --lines 40:80
  jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method

full agent cheatsheet: jarpeek prime --full
`;

export const FIND_CLASS_HELP = `
Examples:
  jarpeek find-class StringJoiner --limit 5
  jarpeek find-class com.example.lib.ApiClient
related: outline <fqn> shows a hit's shape.
`;

export const OUTLINE_HELP = `
Examples:
  jarpeek outline java.util.StringJoiner --kind method
  jarpeek outline java.util.StringJoiner --minimal
  jarpeek outline com.example.lib.ApiClient --no-fields
related: read-member returns one member's code; --table keeps the legacy tabular view.
`;

export const READ_MEMBER_HELP = `
Examples:
  jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'
  jarpeek read-member com.example.lib.ApiClient '#builder' '#build()'
related: read-source --lines a:b for surrounding context.
`;

export const READ_SOURCE_HELP = `
Examples:
  jarpeek read-source com.example.lib.ApiClient --lines 40:80
  jarpeek read-source com.example.lib.ApiClient --full
related: cheaper first — outline, then read-member.
`;

export const READ_RESOURCE_HELP = `
Examples:
  jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'
related: where <coords> for the artifact's on-disk paths.
`;

export const SEARCH_SYMBOLS_HELP = `
Examples:
  jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method
related: find-class when you don't know which artifact holds the class.
`;

export const RESOLVE_HELP = `
Examples:
  jarpeek resolve
related: status reports what the manifest now holds.
`;

export const STATUS_HELP = `
Examples:
  jarpeek status
related: resolve forces a re-resolve.
`;

export const WHERE_HELP = `
Examples:
  jarpeek where com.example:demo-lib:1.0.0
related: read-resource reads non-class entries of the same artifact.
`;

export const MCP_HELP = `
Examples:
  jarpeek mcp
serves stdio MCP; jarpeek init wires it into harnesses.
`;

export const PRIME_HELP = `
Examples:
  jarpeek prime --full
  jarpeek prime --export
the full agent cheatsheet; --export bypasses a .jarpeek/PRIME.md override.
`;

export const INIT_HELP = `
Examples:
  jarpeek init --yes
non-interactive wiring (Claude Code + MCP).
`;
