/**
 * prime: jarpeek's self-description, selected for the harness asking.
 *
 * Precedence: a `.jarpeek/PRIME.md` override wins for every mode (the user
 * wrote it, it replaces the default wholesale) — except `--export`, which
 * exists to print the default itself. Without an override, `--full`/`--mcp`
 * force a mode, else `primeMode` decides — the project's
 * `.jarpeek/config.json`, then the machine-wide config (both written by
 * `jarpeek init` when it wires MCP) — else the `JARPEEK_PRIME_MODE` env
 * var, else cli.
 *
 * Machine-wide wiring runs the session-start hook in every repository, so
 * `--hook-json` answers with nothing where there is no Gradle/Maven build
 * (and no override): non-JVM sessions pay zero context. In a multi-build
 * workspace the text ends with the list of builds, so the agent knows the
 * `project` values from the first turn.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPrimeContent, type PrimeMode } from "./content.js";
import { globalConfigPath } from "../resolver/roots.js";
import { discoverBuilds, type DiscoveredBuild } from "../workspace/discover.js";

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
  /** Empty for a session-start hook outside any JVM build: nothing to inject. */
  text: string;
  source: "default" | "override";
}

/** At most this many builds are listed; the rest are counted. */
const MAX_LISTED_BUILDS = 12;

/** The workspace's builds, one line, for a multi-build workspace; empty otherwise. */
function buildsLine(builds: DiscoveredBuild[]): string {
  if (builds.length < 2) return "";
  const shown = builds.slice(0, MAX_LISTED_BUILDS).map((b) => `${b.rel} (${b.systems.join("+") || "?"})`);
  const more = builds.length > MAX_LISTED_BUILDS ? `, +${builds.length - MAX_LISTED_BUILDS} more` : "";
  return `\nBuilds in this workspace (\`project\` values): ${shown.join(", ")}${more}.\n`;
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
      // tracked files only: this runs at every session start, in every repository
      const { builds } = discoverBuilds(projectRoot, { untracked: false });
      // a session hook outside any JVM build injects nothing
      if (opts.hookJson && builds.length === 0) return { text: "", source: "default" };
      const text = defaultPrimeContent(selectMode(projectRoot, opts));
      selected = { text: `${text}${buildsLine(builds)}`, source: "default" };
    }
  }

  return opts.hookJson ? { ...selected, text: hookEnvelope(selected.text) } : selected;
}

/** Flags, then the project's config, then the machine-wide config, then the env var, else cli. */
function selectMode(projectRoot: string, opts: PrimeOptions): PrimeMode {
  if (opts.mcp) return "mcp";
  if (opts.full) return "cli";
  const fromConfig =
    readPrimeModeConfig(join(projectRoot, PRIME_CONFIG_PATH)) ?? readPrimeModeConfig(globalConfigPath());
  if (fromConfig !== null) return fromConfig;
  return process.env.JARPEEK_PRIME_MODE === "mcp" ? "mcp" : "cli";
}

/** `primeMode` from the config at `path`; null when absent, corrupt, or invalid. */
function readPrimeModeConfig(path: string): PrimeMode | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
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
