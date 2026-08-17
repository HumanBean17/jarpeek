import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_KEY = "JARPEEK_CACHE_DIR";

/**
 * Resolve the cache directory without creating it.
 *
 * `JARPEEK_CACHE_DIR` wins; otherwise the platform convention:
 * darwin `~/Library/Caches/jarpeek`, win32 `%LOCALAPPDATA%/jarpeek`,
 * everything else `~/.cache/jarpeek`.
 */
export function resolveCacheDir(): string {
  const fromEnv = process.env[ENV_KEY];
  if (fromEnv) {
    return fromEnv;
  }
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "jarpeek");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "jarpeek");
    default:
      return join(homedir(), ".cache", "jarpeek");
  }
}

/** Resolve the cache directory and create it (recursive) if missing. */
export function ensureCacheDir(): string {
  const dir = resolveCacheDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
