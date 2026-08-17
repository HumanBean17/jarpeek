/**
 * The harness descriptor table: everything `init` needs to know about the
 * five AI-agent harnesses it can wire, as data. One row per harness; the
 * gemini-family rows come from a factory because qwen and gigacode are
 * Gemini-CLI forks and share its exact settings.json layout.
 *
 * `mcp.target` is resolved by `resolveTarget` in wiring.ts: a `~/` prefix
 * means the user's home directory (codex keeps its config user-scoped),
 * anything else is relative to the project root. Schema sources are
 * recorded as comments in wiring.ts next to the code that writes them.
 */

export type HarnessId = "claude" | "codex" | "gemini" | "qwen" | "gigacode";

/** The on-disk MCP config format a harness consumes. */
export type McpFormat = "mcp-json" | "settings-json" | "codex-toml";

export interface HarnessDescriptor {
  id: HarnessId;
  mcp: {
    /** Config file holding the server list; `~/`-prefixed for user scope. */
    target: string;
    scope: "project" | "user";
    format: McpFormat;
  };
  /** Instructions/memory file at the project root that gets the pointer line. */
  instructionsFile: string;
  /**
   * Whether wireCli installs a session-start hook. Codex was planned as
   * false but its current docs document `[[hooks.SessionStart]]` in
   * config.toml — flipped to true with that evidence (see wiring.ts).
   */
  supportsSessionStartHook: boolean;
}

/** A gemini-family row: `.${id}/settings.json` + `.${ID}.md`, Claude-shaped hooks. */
function geminiFamily(id: Exclude<HarnessId, "claude" | "codex">, doc: string): HarnessDescriptor {
  return {
    id,
    mcp: { target: `.${id}/settings.json`, scope: "project", format: "settings-json" },
    instructionsFile: doc,
    supportsSessionStartHook: true,
  };
}

/** The five harnesses, in prompt/choice order. */
export const HARNESSES: HarnessDescriptor[] = [
  {
    id: "claude",
    mcp: { target: ".mcp.json", scope: "project", format: "mcp-json" },
    instructionsFile: "CLAUDE.md",
    supportsSessionStartHook: true,
  },
  {
    id: "codex",
    mcp: { target: "~/.codex/config.toml", scope: "user", format: "codex-toml" },
    instructionsFile: "AGENTS.md",
    supportsSessionStartHook: true,
  },
  geminiFamily("gemini", "GEMINI.md"),
  geminiFamily("qwen", "QWEN.md"),
  geminiFamily("gigacode", "GIGACODE.md"),
];
