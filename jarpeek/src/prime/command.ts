/**
 * prime: jarpeek's self-description, selected for the harness asking.
 *
 * Precedence: a `.jarpeek/PRIME.md` override wins for every mode (the user
 * wrote it, it replaces the default wholesale) — except `--export`, which
 * exists to print the default itself. Without an override, `--full`/`--mcp`
 * force a mode, else `.jarpeek/config.json`'s `primeMode` decides (written by
 * `jarpeek init` when it wires MCP), else the `JARPEEK_PRIME_MODE` env var,
 * else cli.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPrimeContent, type PrimeMode } from "./content.js";

/** Where the user's override lives, relative to the project root. */
export const PRIME_OVERRIDE_PATH = join(".jarpeek", "PRIME.md");

/** Where init records the wired mode, relative to the project root. */
export const PRIME_CONFIG_PATH = join(".jarpeek", "config.json");

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
      selected = { text: defaultPrimeContent(selectMode(projectRoot, opts)), source: "default" };
    }
  }

  return opts.hookJson ? { ...selected, text: hookEnvelope(selected.text) } : selected;
}

/** Flags, then init's config.json, then the env var, else cli. */
function selectMode(projectRoot: string, opts: PrimeOptions): PrimeMode {
  if (opts.mcp) return "mcp";
  if (opts.full) return "cli";
  const fromConfig = readPrimeModeConfig(projectRoot);
  if (fromConfig !== null) return fromConfig;
  return process.env.JARPEEK_PRIME_MODE === "mcp" ? "mcp" : "cli";
}

/** `primeMode` from `.jarpeek/config.json`; null when absent, corrupt, or invalid. */
function readPrimeModeConfig(projectRoot: string): PrimeMode | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(projectRoot, PRIME_CONFIG_PATH), "utf8"));
  } catch {
    return null;
  }
  const mode = typeof doc === "object" && doc !== null ? (doc as { primeMode?: unknown }).primeMode : undefined;
  return mode === "mcp" || mode === "cli" ? mode : null;
}

/** The Claude Code SessionStart hook payload: the text as additionalContext. */
function hookEnvelope(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  });
}
