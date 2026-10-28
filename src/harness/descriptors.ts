/**
 * The harness descriptor table: everything `init` needs to know about the
 * five AI-agent harnesses it can wire, as data. One row per harness; the
 * gemini-family rows come from a factory because qwen and gigacode are
 * Gemini-CLI forks and share its exact settings.json layout.
 *
 * Two scopes. `user` (init's default) wires once per machine: every repo,
 * worktree and monorepo is covered without a per-project step. `project`
 * writes the configs into one repository (for teams that commit them).
 *
 * Targets are resolved by `resolveTarget` in wiring.ts: a `~/` prefix
 * means the user's home directory, anything else is relative to the
 * project root. Schema sources are recorded as comments in wiring.ts next
 * to the code that writes them.
 */

export type HarnessId = "claude" | "codex" | "gemini" | "qwen" | "gigacode";

/** The on-disk MCP config format a harness consumes. */
export type McpFormat = "mcp-json" | "settings-json" | "codex-toml";

export type WiringScope = "user" | "project";

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
  /**
   * Machine-wide targets. `mcp: "claude-cli"` means the harness owns its
   * user config (Claude Code's `~/.claude.json` is live application state)
   * and the entry goes through `claude mcp add --scope user`; otherwise the
   * file and format jarpeek edits itself. `hooks` is the settings file the
   * SessionStart hook merges into (same format as `mcp`'s file family).
   */
  user: {
    mcp: "claude-cli" | { target: string; format: Exclude<McpFormat, "mcp-json"> };
    instructionsFile: string;
    hooks: string;
  };
}

/** A gemini-family row: `.${id}/settings.json` + `.${ID}.md`, Claude-shaped hooks. */
function geminiFamily(id: Exclude<HarnessId, "claude" | "codex">, doc: string): HarnessDescriptor {
  return {
    id,
    mcp: { target: `.${id}/settings.json`, scope: "project", format: "settings-json" },
    instructionsFile: doc,
    supportsSessionStartHook: true,
    // the forks read user settings and memory from ~/.<id>/, like Gemini CLI
    user: {
      mcp: { target: `~/.${id}/settings.json`, format: "settings-json" },
      instructionsFile: `~/.${id}/${doc}`,
      hooks: `~/.${id}/settings.json`,
    },
  };
}

/** The five harnesses, in prompt/choice order. */
export const HARNESSES: HarnessDescriptor[] = [
  {
    id: "claude",
    mcp: { target: ".mcp.json", scope: "project", format: "mcp-json" },
    instructionsFile: "CLAUDE.md",
    supportsSessionStartHook: true,
    user: { mcp: "claude-cli", instructionsFile: "~/.claude/CLAUDE.md", hooks: "~/.claude/settings.json" },
  },
  {
    id: "codex",
    mcp: { target: "~/.codex/config.toml", scope: "user", format: "codex-toml" },
    instructionsFile: "AGENTS.md",
    supportsSessionStartHook: true,
    user: {
      mcp: { target: "~/.codex/config.toml", format: "codex-toml" },
      instructionsFile: "~/.codex/AGENTS.md",
      hooks: "~/.codex/config.toml",
    },
  },
  geminiFamily("gemini", "GEMINI.md"),
  geminiFamily("qwen", "QWEN.md"),
  geminiFamily("gigacode", "GIGACODE.md"),
];
