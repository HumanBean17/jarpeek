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
/** A crude "this is decompiled Java, not a stack trace" probe for the stderr fallback. */
const LOOKS_LIKE_JAVA = /\b(?:class|interface|enum|record)\s+[A-Za-z_$]/;

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
 * analysis chatter to stderr; an empty stdout falls back to stderr only when
 * it actually looks like Java source, because an unloadable class makes CFR
 * exit 0 with the failure message on stderr.
 */
function selectSource(run: RunResult): string | undefined {
  if (run.stdout.trim().length > 0) return run.stdout;
  if (LOOKS_LIKE_JAVA.test(run.stderr)) return run.stderr;
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
        run = await exec("java", ["-jar", cfrJarPath(), classFile, "--silent", "true"], {
          timeoutMs: CFR_TIMEOUT_MS,
        });
      } catch (e) {
        if (e instanceof SpawnError) {
          return { provenance: "signature", reason: "no-jvm" };
        }
        return { provenance: "signature", reason: "cfr-failed", detail: detailTail((e as Error).message) };
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

      // Advisory validation: a parse that yields zero classes is still cached
      // and returned as-is (degraded) — raw CFR output beats no output.
      parseJavaSource(source, `${internalName}.java`);

      await writeCache(cacheFile, source);
      return { provenance: "decompiled", source, cached: false };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  } catch (e) {
    return { provenance: "signature", reason: "cfr-failed", detail: detailTail((e as Error).message) };
  }
}
