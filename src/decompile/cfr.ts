/**
 * CFR decompiler adapter: decompiles one class at a time from a binary jar
 * using the vendored CFR jar, caching the result per (coordinates, class,
 * CFR version).
 *
 * The vendored jar makes the tool self-contained — no network, no separate
 * CFR install — and `java` is probed at run time so machines without a JVM
 * degrade to signature-only answers instead of failing. The adapter never
 * throws: every failure path (no JVM, unreadable jar, missing entry, CFR
 * error, empty output) is a `signature` result describing why.
 */
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJavaSource } from "../parse/java-lexer.js";
import { listZipEntries, readZipEntry } from "../parse/zip.js";
import { runWithTimeout, SpawnError, type RunResult } from "../util/exec.js";

/** Version of the vendored CFR jar (vendor/cfr.jar); cache keys embed it. */
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
 * The `java` to run: `$JAVA_HOME/bin/java` when JAVA_HOME points at a real
 * install (a JDK may not be on PATH at all), else the PATH `java`. Env-only
 * — when neither resolves the spawn itself fails and the caller degrades to
 * `no-jvm`, which is the honest answer.
 */
export function javaCommand(): string {
  const home = process.env.JAVA_HOME;
  if (home !== undefined && home !== "") {
    const exe = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(exe)) return exe;
  }
  return "java";
}

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

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `<cacheDir>/v1/decompiled/<sha256(coordinates)>/<sha256(internalName ":" CFR_VERSION)>.java`
 * — per-artifact directory, class+version-keyed file, so a CFR upgrade
 * invalidates nothing silently.
 */
function decompileCachePath(cacheDir: string, coordinates: string, internalName: string): string {
  return join(
    cacheDir,
    "v1",
    "decompiled",
    sha256Hex(coordinates),
    `${sha256Hex(`${internalName}:${CFR_VERSION}`)}.java`,
  );
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

/** Read a cached decompile; undefined means "not cached, go decompile". */
async function readCache(cacheFile: string): Promise<string | undefined> {
  try {
    return await readFile(cacheFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Best-effort cache write (tmp + rename); failures degrade to uncached success. */
async function writeCache(cacheFile: string, source: string): Promise<void> {
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${randomUUID()}.tmp`;
    await writeFile(tmp, source, "utf8");
    await rename(tmp, cacheFile);
  } catch {
    // a failed cache write must never fail the decompile itself
  }
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
 * Decompile `internalName` (e.g. `com/foo/Bar`) from `binaryJar` with the
 * vendored CFR, consulting and then populating the per-class cache under
 * `cacheDir`. Never throws — every failure is a signature-result.
 */
export async function decompileClass(
  cacheDir: string,
  coordinates: string,
  binaryJar: string,
  internalName: string,
  opts: DecompileOptions = {},
): Promise<DecompileResult> {
  const exec = opts.exec ?? runWithTimeout;
  const cacheFile = decompileCachePath(cacheDir, coordinates, internalName);
  try {
    const cached = await readCache(cacheFile);
    if (cached !== undefined) {
      return { provenance: "decompiled", source: cached, cached: true };
    }

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
      // (e.g. CFR failure text that slipped through shape detection). Caching
      // it would poison the cache permanently, so refuse and degrade instead.
      const parsed = parseJavaSource(source, `${internalName}.java`);
      if (parsed.classes.length === 0) {
        return {
          provenance: "signature",
          reason: "cfr-failed",
          detail: detailTail(run.stderr || "cfr output parsed to zero classes"),
        };
      }

      await writeCache(cacheFile, source);
      return { provenance: "decompiled", source, cached: false };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  } catch (e) {
    return { provenance: "signature", reason: "cfr-failed", detail: detailTail(errorMessage(e)) };
  }
}
