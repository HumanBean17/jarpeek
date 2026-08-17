/**
 * prime: jarpeek's self-description, selected for the harness asking.
 *
 * Precedence: a `.jarpeek/PRIME.md` override wins for every mode (the user
 * wrote it, it replaces the default wholesale) — except `--export`, which
 * exists to print the default itself. Without an override, `--full`/`--mcp`
 * force a mode, else the environment decides (init's MCP wiring exports
 * JARPEEK_PRIME_MODE=mcp), else cli.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPrimeContent, type PrimeMode } from "./content.js";

/** Where the user's override lives, relative to the project root. */
export const PRIME_OVERRIDE_PATH = join(".jarpeek", "PRIME.md");

export interface PrimeOptions {
  /** Force the full cli cheatsheet (over the short mcp card). */
  full?: boolean;
  /** Force the short mcp card. */
  mcp?: boolean;
  /** Print the default cli content even when an override exists. */
  exportContent?: boolean;
  /** Wrap the text in a SessionStart hook envelope. */
  hookJson?: boolean;
}

export interface PrimeResult {
  text: string;
  source: "default" | "override";
}

/**
 * Select the prime text for `projectRoot`. Reads only the override file —
 * never the index, never the manifest — so it stays cheap enough for a
 * SessionStart hook.
 */
export function prime(projectRoot: string, opts: PrimeOptions = {}): PrimeResult {
  let selected: PrimeResult;

  if (opts.exportContent) {
    selected = { text: defaultPrimeContent("cli"), source: "default" };
  } else {
    const overridePath = join(projectRoot, PRIME_OVERRIDE_PATH);
    if (existsSync(overridePath)) {
      selected = { text: readFileSync(overridePath, "utf8"), source: "override" };
    } else {
      selected = { text: defaultPrimeContent(selectMode(opts)), source: "default" };
    }
  }

  return opts.hookJson ? { ...selected, text: hookEnvelope(selected.text) } : selected;
}

/** Flags first, then the env var init sets when it wires MCP, else cli. */
function selectMode(opts: PrimeOptions): PrimeMode {
  if (opts.mcp) return "mcp";
  if (opts.full) return "cli";
  return process.env.JARPEEK_PRIME_MODE === "mcp" ? "mcp" : "cli";
}

/** The Claude Code SessionStart hook payload: the text as additionalContext. */
function hookEnvelope(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  });
}
