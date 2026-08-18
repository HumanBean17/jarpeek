/**
 * CFR decompiler adapter: decompiles one class at a time from a binary jar
 * using the vendored CFR jar. `createDecompiler` returns a memoized
 * decompile function: successful results are remembered per (coordinates,
 * class) in-process, failures are not — a JVM appearing later in the
 * process must still be able to change the answer. No derived state is
 * written to disk; only transient temp files carry the class through CFR.
 *
 * The vendored jar makes the tool self-contained — no network, no separate
 * CFR install — and `java` is probed at run time so machines without a JVM
 * degrade to signature-only answers instead of failing. The adapter never
 * throws: every failure path (no JVM, unreadable jar, missing entry, CFR
 * error, empty output) is a `signature` result describing why.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJavaSource } from "../parse/java-lexer.js";
import { listZipEntries, readZipEntry } from "../parse/zip.js";
import { runWithTimeout, SpawnError, type RunResult } from "../util/exec.js";
import { javaCommand } from "../util/jvm.js";

/** Version of the vendored CFR jar (vendor/cfr.jar). */
export const CFR_VERSION = "0.152";

const CFR_TIMEOUT_MS = 60_000;
const DETAIL_TAIL_CHARS = 400;
/**
 * A declaration-shaped line — `class Foo`, `enum Bar`, ... with a real Java
 * identifier after the keyword (so prose like "Can't load the class specified"
 * or "for class file 'X'" does not match: no identifier follows).
 */
const DECLARATION_LINE = /^[^\n]*\b(?:class|interface|enum|record|@interface)\s+[A-Za-z_$][A-Za-z0-9_$]*/m;
/**
 * CFR's own failure chatter. An unloadable class makes CFR exit 0 with the
 * failure on stderr, so the stderr fallback must veto these markers. Applied
 * to stderr only: genuine decompiled code happily contains `catch (Exception
 * e)`, so stdout is gated on shape, not on these markers.
 */
const CFR_FAILURE_MARKERS =
  /can't load|cannot load|unable to|exception|error\s*:|caused by|at org\.benf\.cfr/i;

export type DecompileResult =
  | { provenance: "decompiled"; source: string; cached: boolean }
  | { provenance: "signature"; reason: "no-jvm" | "cfr-failed"; detail?: string };

export interface DecompileOptions {
  /** Injectable for tests; defaults to the real child-process runner. */
  exec?: typeof runWithTimeout;
}

let resolvedJarPath: string | undefined;

/**
 * Absolute path to the vendored CFR jar. The package root is found by walking
 * up from this module until a directory containing `vendor/` appears, so the
 * same code resolves from both `src/decompile` (tsx/vitest) and
 * `dist/decompile` (compiled output, which mirrors the src layout).
 */
export function cfrJarPath(): string {
  if (resolvedJarPath === undefined) {
    resolvedJarPath = resolveCfrJarPath();
  }
  return resolvedJarPath;
}

function resolveCfrJarPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  for (let up = 0; up < 4; up++) {
    if (existsSync(join(dir, "vendor"))) {
      return join(dir, "vendor", "cfr.jar");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // vendored jar absent (trimmed install?): still return the expected layout
  // path so downstream errors point somewhere meaningful
  return join(dirname(dirname(moduleDir)), "vendor", "cfr.jar");
}

/** Last `DETAIL_TAIL_CHARS` characters, trimmed — enough to identify a CFR failure. */
function detailTail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > DETAIL_TAIL_CHARS
    ? trimmed.slice(trimmed.length - DETAIL_TAIL_CHARS)
    : trimmed;
}

/** Message of an unknown rejection — a non-Error throw must not escape the catch. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Pick the decompiled source from a CFR run. CFR prints code to stdout and
 * analysis chatter to stderr. Non-empty stdout is trusted on shape alone
 * (real code contains `catch (Exception e)`); the stderr fallback must both
 * look like declarations and carry no CFR failure markers, because an
 * unloadable class makes CFR exit 0 with the failure message on stderr.
 */
function selectSource(run: RunResult): string | undefined {
  if (run.stdout.trim().length > 0) return run.stdout;
  if (DECLARATION_LINE.test(run.stderr) && !CFR_FAILURE_MARKERS.test(run.stderr)) {
    return run.stderr;
  }
  return undefined;
}

/**
 * Decompile one class (e.g. `com/foo/Bar`) from `binaryJar` with the vendored
 * CFR. Never throws — every failure is a signature-result.
 */
export type DecompileFn = (
  coordinates: string,
  binaryJar: string,
  internalName: string,
) => Promise<DecompileResult>;

/**
 * Create a memoized decompile function: successful results are remembered in
 * a closure Map keyed `"${coordinates}\n${internalName}"`, failures are not
 * (a JVM appearing later in the process must be able to change the answer).
 * There is no disk cache — the temp-dir round-trip below is the only I/O.
 */
export function createDecompiler(opts: DecompileOptions = {}): DecompileFn {
  const exec = opts.exec ?? runWithTimeout;
  const memo = new Map<string, string>();

  return async (coordinates, binaryJar, internalName): Promise<DecompileResult> => {
    const key = `${coordinates}\n${internalName}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return { provenance: "decompiled", source: cached, cached: true };
    }

    try {
      const entry = (await listZipEntries(binaryJar)).find((e) => e.name === `${internalName}.class`);
      if (entry === undefined) {
        return { provenance: "signature", reason: "cfr-failed", detail: "entry not found" };
      }
      const classBytes = await readZipEntry(binaryJar, entry);

      const workDir = await mkdtemp(join(tmpdir(), "jarpeek-cfr-"));
      try {
        const classFile = join(workDir, "subject.class");
        await writeFile(classFile, classBytes);

        let run: RunResult;
        try {
          run = await exec(javaCommand(), ["-jar", cfrJarPath(), classFile, "--silent", "true"], {
            timeoutMs: CFR_TIMEOUT_MS,
          });
        } catch (e) {
          if (e instanceof SpawnError) {
            return { provenance: "signature", reason: "no-jvm" };
          }
          return { provenance: "signature", reason: "cfr-failed", detail: detailTail(errorMessage(e)) };
        }

        if (run.code !== 0) {
          return {
            provenance: "signature",
            reason: "cfr-failed",
            detail: detailTail(run.stderr || run.stdout || `cfr exited with code ${run.code}`),
          };
        }
        const source = selectSource(run);
        if (source === undefined) {
          return {
            provenance: "signature",
            reason: "cfr-failed",
            detail: detailTail(run.stderr || "cfr produced no source output"),
          };
        }

        // A parse that yields zero classes means the output is not Java source
        // (e.g. CFR failure text that slipped through shape detection). Serving
        // it would read as real code, so refuse and degrade instead.
        const parsed = parseJavaSource(source, `${internalName}.java`);
        if (parsed.classes.length === 0) {
          return {
            provenance: "signature",
            reason: "cfr-failed",
            detail: detailTail(run.stderr || "cfr output parsed to zero classes"),
          };
        }

        memo.set(key, source);
        return { provenance: "decompiled", source, cached: false };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    } catch (e) {
      return { provenance: "signature", reason: "cfr-failed", detail: detailTail(errorMessage(e)) };
    }
  };
}
