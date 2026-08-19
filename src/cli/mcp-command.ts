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
import { MCP_HELP } from "./help.js";

export interface McpOptions {
  project?: string;
}

/** Wire the mcp subcommand onto the program. */
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("serve the MCP stdio server for this project")
    .addHelpText("after", MCP_HELP)
    .action(async () => {
      await startMcpServer(program.opts<McpOptions>().project ?? process.cwd());
    });
}
