/**
 * The `mcp` subcommand: hand the process over to the stdio MCP server.
 *
 * Stdio is the whole point — the host client owns this process's stdin and
 * stdout, so the server must never write a banner there. `--project` from the
 * CLI's global flags picks the project root; without it the server serves
 * the cwd.
 */
import type { Command } from "commander";
import { startMcpServer } from "../mcp/server.js";
import { mcpHelp } from "./help.js";
import type { Catalog } from "./i18n/index.js";

export interface McpOptions {
  project?: string;
  /** The global --build-tool value, threaded into the server's context. */
  buildTool?: string;
}

/**
 * Wire the mcp subcommand onto the program. `t` is the build-time catalog
 * (the server itself stays English — it speaks to agents, not humans).
 */
export function registerMcpCommand(program: Command, t: Catalog): void {
  program
    .command("mcp")
    .description(t["cmd.mcp"])
    .addHelpText("after", () => mcpHelp(t))
    .action(async () => {
      const opts = program.opts<McpOptions>();
      await startMcpServer(opts.project ?? process.cwd(), opts.buildTool);
    });
}
