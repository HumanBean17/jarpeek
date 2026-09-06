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
 *
 * Each block is a function of the message catalog (human-mode localization;
 * example invocation lines stay verbatim in every locale). The English
 * catalog's values reproduce the historical strings byte-for-byte — the
 * default help output is the regression oracle.
 */
import type { Catalog } from "./i18n/index.js";

/** Appended to `jarpeek --help`: the decision guidance and the way out. */
export function topLevelHelp(t: Catalog): string {
  return `
${t["help.frugal"]}

${t["help.examples"]}
  jarpeek find-class StringJoiner --limit 5
  jarpeek outline java.util.StringJoiner --kind method
  jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'
  jarpeek read-source com.example.lib.ApiClient --lines 40:80
  jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method

${t["help.primePointer"]}
`;
}

export function findClassHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek find-class StringJoiner --limit 5
  jarpeek find-class com.example.lib.ApiClient
${t["help.related"]} ${t["related.find-class"]}
`;
}

export function outlineHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek outline java.util.StringJoiner --kind method
  jarpeek outline java.util.StringJoiner --minimal
  jarpeek outline com.example.lib.ApiClient --no-fields
${t["help.related"]} ${t["related.outline"]}
`;
}

export function readMemberHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'
  jarpeek read-member com.example.lib.ApiClient '#builder' '#build()'
${t["help.related"]} ${t["related.read-member"]}
`;
}

export function readSourceHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek read-source com.example.lib.ApiClient --lines 40:80
  jarpeek read-source com.example.lib.ApiClient --full
${t["help.related"]} ${t["related.read-source"]}
`;
}

export function readResourceHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'
${t["help.related"]} ${t["related.read-resource"]}
`;
}

export function searchSymbolsHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method
${t["help.related"]} ${t["related.search-symbols"]}
`;
}

export function resolveHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek resolve
${t["help.related"]} ${t["related.resolve"]}
`;
}

export function statusHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek status
${t["help.related"]} ${t["related.status"]}
`;
}

export function whereHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek where com.example:demo-lib:1.0.0
${t["help.related"]} ${t["related.where"]}
`;
}

export function mcpHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek mcp
${t["help.mcp"]}
`;
}

export function primeHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek prime --full
  jarpeek prime --export
${t["help.prime"]}
`;
}

export function initHelp(t: Catalog): string {
  return `
${t["help.examples"]}
  jarpeek init --yes
${t["help.init"]}
`;
}
