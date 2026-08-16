import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_NAME = "jarpeek.lock";
const STALE_MS = 10 * 60 * 1000;
const MAX_RETRIES = 50;
const RETRY_DELAY_MS = 100;

export class LockTimeoutError extends Error {
  constructor(lockPath: string, attempts: number) {
    super(`could not acquire lock ${lockPath} after ${attempts} attempts`);
    this.name = "LockTimeoutError";
  }
}

/** Attempt one acquisition pass. Returns true when this process holds the lock. */
function tryAcquire(cacheDir: string): boolean {
  const lockPath = join(cacheDir, LOCK_NAME);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    // A lock whose mtime is older than the stale threshold is a dead writer:
    // steal it and retry acquisition once in this pass.
    const stats = statSync(lockPath);
    if (Date.now() - stats.mtimeMs > STALE_MS) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process stole it first; the plain retry loop handles it.
      }
      return tryAcquire(cacheDir);
    }
    return false;
  }
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Run `fn` while holding the writers lock at `<cacheDir>/jarpeek.lock`.
 *
 * Acquisition is O_EXCL-based; a lock older than 10 minutes is stolen.
 * Fresh foreign locks are retried up to 50 times with 100ms sleeps, then
 * `LockTimeoutError` is thrown. The lock is always released in `finally`.
 * Read paths elsewhere must not take this lock.
 */
export async function withLock<T>(cacheDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(cacheDir, LOCK_NAME);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (tryAcquire(cacheDir)) {
      try {
        return await fn();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone (e.g. stale-steal by another process); nothing to release.
        }
      }
    }
    await sleep(RETRY_DELAY_MS);
  }
  throw new LockTimeoutError(lockPath, MAX_RETRIES);
}
