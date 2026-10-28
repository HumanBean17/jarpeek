/**
 * The machine-wide cache directory: where jarpeek keeps every piece of
 * derived state (resolved-dependency manifests, the Gradle init script,
 * resolve locks), so no checkout — main, worktree, or clone — ever gets
 * files written into it.
 *
 * `JARPEEK_CACHE_DIR` wins; otherwise the platform's user cache location:
 * `~/Library/Caches/jarpeek` (macOS), `%LOCALAPPDATA%\jarpeek` (Windows),
 * `$XDG_CACHE_HOME/jarpeek` or `~/.cache/jarpeek` (elsewhere) — the same
 * directory 0.1's index used; its leftovers sit in their own subdirectory
 * and are never read.
 * `JARPEEK_HOME` replaces the home directory, as for user-scoped configs.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function cacheDir(): string {
  const explicit = process.env.JARPEEK_CACHE_DIR;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = process.env.JARPEEK_HOME ?? homedir();
  if (process.platform === "darwin") return join(home, "Library", "Caches", "jarpeek");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local !== undefined && local.length > 0
      ? join(local, "jarpeek")
      : join(home, "AppData", "Local", "jarpeek");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg !== undefined && xdg.length > 0 ? join(xdg, "jarpeek") : join(home, ".cache", "jarpeek");
}
