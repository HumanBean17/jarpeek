import { spawn } from "node:child_process";

export class TimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`command "${cmd}" timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class SpawnError extends Error {
  constructor(cmd: string, cause: NodeJS.ErrnoException) {
    super(`failed to spawn "${cmd}": ${cause.message}`);
    this.name = "SpawnError";
  }
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Spawn a command, collect utf8 stdout/stderr, and enforce a timeout.
 *
 * Non-zero exit codes are resolved values, not rejections. On timeout the
 * child gets SIGTERM, escalating to SIGKILL after a 2s grace, and the
 * promise rejects with `TimeoutError`. A spawn failure (e.g. ENOENT)
 * rejects with `SpawnError`.
 */
export function runWithTimeout(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, cwd, env, maxBuffer = DEFAULT_MAX_BUFFER } = opts;

  return new Promise<RunResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (error) {
      reject(new SpawnError(cmd, error as NodeJS.ErrnoException));
      return;
    }

    let settled = false;
    let timedOut = false;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let killTimer: NodeJS.Timeout | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      fn();
    };

    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const grace = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      grace.unref();
    }, timeoutMs);
    killTimer.unref();

    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() => reject(new SpawnError(cmd, error)));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen <= maxBuffer) stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen <= maxBuffer) stderrChunks.push(chunk);
    });

    child.on("close", () => {
      settle(() => {
        if (timedOut) {
          reject(new TimeoutError(cmd, timeoutMs));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          code: child.exitCode,
        });
      });
    });
  });
}
