/**
 * Cross-process resolve lock, one per manifest key.
 *
 * Content-addressed manifests are shared by every checkout with the same
 * build files, so parallel agents in sibling worktrees would otherwise all
 * run the same Gradle/Maven resolve at once. The first process to create
 * `<cache>/locks/<key>.lock` (O_EXCL) resolves; the others wait, then find
 * the fresh manifest and skip their own run.
 *
 * A lock is abandoned — and taken over — when its owner pid is gone or its
 * mtime stopped advancing for STALE_LOCK_MS (the holder refreshes it every
 * REFRESH_MS, so only a dead or wedged holder ages out).
 */
import { mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "../util/cache-dir.js";

const POLL_MS = 250;
const REFRESH_MS = 20_000;
const STALE_LOCK_MS = 5 * 60_000;

export interface LockOptions {
  /** Called once when this process starts waiting on another holder. */
  onWait?: () => void;
}

function lockPath(key: string): string {
  return join(cacheDir(), "locks", `${key}.lock`);
}

function ownerAlive(path: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function abandoned(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) return true;
  } catch {
    return false; // vanished: the next create attempt decides
  }
  return !ownerAlive(path);
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** Run `fn` holding the lock for `key`; waits (polling) while another live process holds it. */
export async function withResolveLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const path = lockPath(key);
  mkdirSync(join(cacheDir(), "locks"), { recursive: true });
  let waited = false;
  while (!tryCreate(path)) {
    if (abandoned(path)) {
      try {
        unlinkSync(path);
      } catch {
        // another waiter took it over first
      }
      continue;
    }
    if (!waited) {
      waited = true;
      opts.onWait?.();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const refresh = setInterval(() => {
    try {
      const now = Date.now() / 1000;
      utimesSync(path, now, now);
    } catch {
      // removed under us: release below tolerates it
    }
  }, REFRESH_MS);
  refresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
}
