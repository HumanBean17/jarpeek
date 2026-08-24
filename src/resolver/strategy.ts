/**
 * Build-tool strategy: which mvn/gradle command runs resolves — the system
 * install from PATH, the project's root wrapper, or system-first with the
 * wrapper as fallback (absence and failure both advance).
 *
 * The knob is tri-state and reaches this module through three surfaces with
 * precedence flag > env > config > auto: the CLI's `--build-tool` flag, the
 * `JARPEEK_BUILD_TOOL` env var, and the `buildTool` field of
 * `.jarpeek/config.json`. An absent or invalid value at any layer falls
 * through to the next layer, exactly like primeMode's convergence — except
 * that env here beats config: primeMode's config is `init`-written wiring
 * (authoritative), while `buildTool` is hand-authored per-machine state and
 * a shell-level override (`JARPEEK_BUILD_TOOL=system jarpeek resolve`)
 * should win for one-off debugging.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIME_CONFIG_PATH } from "../prime/command.js";

export type BuildToolStrategy = "auto" | "system" | "wrapper";

/** Every valid strategy; the single source for validation and CLI choices. */
export const BUILD_TOOL_STRATEGIES: readonly BuildToolStrategy[] = ["auto", "system", "wrapper"];

function isStrategy(value: string | undefined): value is BuildToolStrategy {
  return value !== undefined && (BUILD_TOOL_STRATEGIES as readonly string[]).includes(value);
}

/**
 * `buildTool` from `.jarpeek/config.json`; null when absent, corrupt, or
 * invalid — the caller falls through to the next layer. Mirrors
 * `readPrimeModeConfig` in `prime/command.ts`.
 */
function readConfigStrategy(projectRoot: string): BuildToolStrategy | null {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(projectRoot, PRIME_CONFIG_PATH), "utf8"));
  } catch {
    return null;
  }
  const value =
    typeof doc === "object" && doc !== null ? (doc as { buildTool?: unknown }).buildTool : undefined;
  const raw = typeof value === "string" ? value : undefined;
  return isStrategy(raw) ? raw : null;
}

/**
 * The effective strategy for one resolution context: the validated flag
 * value when given, else the env var, else the config field, else `auto`.
 * Never throws and never writes.
 */
export function effectiveBuildToolStrategy(projectRoot: string, flagValue?: string): BuildToolStrategy {
  if (isStrategy(flagValue)) return flagValue;
  const env = process.env.JARPEEK_BUILD_TOOL;
  if (isStrategy(env)) return env;
  return readConfigStrategy(projectRoot) ?? "auto";
}
