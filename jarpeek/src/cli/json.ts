/**
 * The `--json` path: print the core result object verbatim.
 *
 * This is the CLI/MCP parity contract — the exact same object the MCP tool
 * returns (Task 20) must serialize to this exact string. No shaping, no
 * truncation, no extra keys.
 */

/** Serialize a core result exactly as `--json` prints it (no trailing newline). */
export function renderJson(result: unknown): string {
  return JSON.stringify(result);
}
