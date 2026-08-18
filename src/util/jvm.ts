/**
 * Shared JVM probe: is there a `java` on this machine, and which version?
 *
 * One question, several askers (status's health report, find-class's
 * provenance promise) — and one answer per process, because a JVM cannot
 * appear or vanish under a running jarpeek. The probe is module-memoized:
 * every caller awaits the same `java -version` run.
 */
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

/** Probe the JVM once (memoized per process); a failed spawn answers unavailable. */
export function probeJvmOnce(): Promise<JvmProbe> {
  return (jvmProbe ??= runWithTimeout("java", ["-version"], { timeoutMs: 15_000 })
    .then((run): JvmProbe => {
      const version = extractJvmVersion(run);
      return version === undefined ? { available: true } : { available: true, version };
    })
    .catch((): JvmProbe => ({ available: false })));
}
