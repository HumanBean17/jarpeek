/**
 * Shared JVM probe: is there a `java` on this machine, and which version?
 *
 * One question, several askers (status's health report, find-class's
 * provenance promise) — and one answer per process, because a JVM cannot
 * appear or vanish under a running jarpeek. The probe is module-memoized:
 * every caller awaits the same `java -version` run.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runWithTimeout, type RunResult } from "./exec.js";

/** The probe's answer: `version` absent when `-version` printed no parseable line. */
export interface JvmProbe {
  available: boolean;
  version?: string;
}

/**
 * `version "25.0.2"` → `25.0.2` from whichever stream printed it — modern
 * JVMs print the version line to stderr, older ones to stdout. Extracted so
 * the regex behavior is unit-testable without spawning anything.
 */
export function extractJvmVersion(run: Pick<RunResult, "stdout" | "stderr">): string | undefined {
  const match = /version "([^"]+)"/.exec(`${run.stderr}\n${run.stdout}`);
  return match === null ? undefined : match[1];
}

/** `java -version` probes once per process; the answer cannot change under us. */
let jvmProbe: Promise<JvmProbe> | undefined;

/**
 * The `java` to run: `$JAVA_HOME/bin/java` when JAVA_HOME points at a real
 * install (a JDK may not be on PATH at all), else the PATH `java`. Env-only
 * — when neither resolves the spawn itself fails and the caller degrades to
 * `no-jvm`, which is the honest answer. Shared by the probe and the CFR
 * adapter so both answer about the same JVM.
 */
export function javaCommand(): string {
  const home = process.env.JAVA_HOME;
  if (home !== undefined && home !== "") {
    const exe = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(exe)) return exe;
  }
  return "java";
}

/** Probe the JVM once (memoized per process); a failed spawn answers unavailable. */
export function probeJvmOnce(): Promise<JvmProbe> {
  return (jvmProbe ??= runWithTimeout(javaCommand(), ["-version"], { timeoutMs: 15_000 })
    .then((run): JvmProbe => {
      const version = extractJvmVersion(run);
      return version === undefined ? { available: true } : { available: true, version };
    })
    .catch((): JvmProbe => ({ available: false })));
}
