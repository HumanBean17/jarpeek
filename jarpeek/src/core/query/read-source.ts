/**
 * readSource: source text for one class, in the size the caller asked for.
 *
 * `outline` (default) reuses the outline rows. `full` resolves the winner
 * artifact's best source — module sourceDir file, sources-jar entry (JDK
 * src.zip included), or a whole-class CFR decompile for binary-only
 * artifacts — and `lines` slices that content. When no real source can be
 * produced (JDK classes where decompilation is out of scope, or a decompile
 * that failed) the signature rows render as text under provenance
 * "signature" with a header note saying why. Lookup misses throw
 * LookupMissError like outline does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Provenance } from "../types.js";
import { decompileClass } from "../../decompile/cfr.js";
import { listZipEntries, readTextEntry } from "../../parse/zip.js";
import { sliceLines, splitLines } from "../../util/lines.js";
import type { QueryContext } from "./context.js";
import {
  isClassKind,
  mergedDegraded,
  orderedLookup,
  outline,
  servedStale,
  type OutlineResult,
} from "./outline.js";

export type ReadSourceMode = "outline" | "full" | "lines";

export interface ReadSourceOptions {
  mode?: ReadSourceMode;
  from?: number;
  to?: number;
}

export interface FullReadResult {
  mode: "full";
  fqn: string;
  coordinates: string;
  file: string;
  provenance: Provenance;
  stale?: boolean;
  content: string;
  startLine: 1;
  lineCount: number;
  alternatives?: Array<{ coordinates: string }>;
  degraded: string[];
}

export interface LinesReadResult {
  mode: "lines";
  fqn: string;
  coordinates: string;
  file: string;
  provenance: Provenance;
  stale?: boolean;
  lines: string[];
  startLine: number;
  endLine: number;
  lineCount: number;
  clamped: boolean;
  alternatives?: Array<{ coordinates: string }>;
  degraded: string[];
}

export type ReadSourceResult = ({ mode: "outline" } & OutlineResult) | FullReadResult | LinesReadResult;

interface ResolvedContent {
  coordinates: string;
  file: string;
  provenance: Provenance;
  content: string;
  stale: boolean;
  alternatives: Array<{ coordinates: string }>;
  degraded: string[];
}

const JDK_NOTE = "signatures only (jdk: decompilation is out of scope)";

/** The winner's best whole-file source text, with the provenance it came from. */
async function resolveContent(ctx: QueryContext, fqn: string): Promise<ResolvedContent> {
  await ctx.ensureReady();
  const { winner, alternatives } = await orderedLookup(ctx, fqn);
  const meta = winner.meta;
  const classRecord = winner.records.find((record) => isClassKind(record.kind));
  const internalName = fqn.replaceAll(".", "/");
  const entryPath = classRecord?.file ?? `${internalName}.java`;
  const stale = await servedStale(ctx);
  const degraded = mergedDegraded(ctx, stale ? ["stale index served"] : []);

  const resolved = (file: string, provenance: Provenance, content: string): ResolvedContent => ({
    coordinates: meta.coordinates,
    file,
    provenance,
    content,
    stale,
    alternatives,
    degraded,
  });

  const signatureFallback = (note: string): ResolvedContent => ({
    ...resolved(classRecord?.file ?? `${internalName}.java`, "signature", [
      note,
      ...winner.records.map((record) => record.signature),
    ].join("\n")),
  });

  // 1. module sourceDir: the record's file is projectRoot-relative
  if (meta.sourceDir) {
    try {
      return resolved(entryPath, "source", readFileSync(join(ctx.projectRoot, entryPath), "utf8"));
    } catch {
      // unreadable path — fall through to the next source
    }
  }

  // 2. sources jar (external sources or the JDK's src.zip — same zip reader)
  if (meta.sourcesJar) {
    try {
      const entries = await listZipEntries(meta.sourcesJar);
      const entry =
        entries.find((e) => e.name === entryPath) ??
        entries.find((e) => e.name.endsWith(`/${entryPath}`));
      if (entry) {
        return resolved(entry.name, "source", await readTextEntry(meta.sourcesJar, entry));
      }
    } catch {
      // unreadable archive or entry — fall through
    }
  }

  // 3. binary jar: whole-class decompile (skipped where decompilation is out of scope)
  if (meta.binaryJar && !meta.noDecompile) {
    const result = await decompileClass(ctx.cacheDir, meta.coordinates, meta.binaryJar, internalName);
    if (result.provenance === "decompiled") {
      return resolved(`${internalName}.java (decompiled)`, "decompiled", result.source);
    }
    const detail = "reason" in result ? `${result.reason}${result.detail ? `: ${result.detail}` : ""}` : "unknown";
    return signatureFallback(`signatures only (decompilation failed: ${detail})`);
  }

  // 4. nothing better than signatures (JDK classesDir, vanished sources, ...)
  return signatureFallback(meta.noDecompile || meta.kind === "jdk" ? JDK_NOTE : "signatures only (no source available)");
}

export async function readSource(
  ctx: QueryContext,
  fqn: string,
  opts: ReadSourceOptions = {},
): Promise<ReadSourceResult> {
  const mode = opts.mode ?? "outline";
  if (mode === "outline") {
    return { mode, ...(await outline(ctx, fqn)) };
  }
  if (mode === "lines" && (opts.from === undefined || opts.to === undefined)) {
    throw new Error("lines mode requires from and to");
  }

  const source = await resolveContent(ctx, fqn);
  const lineCount = splitLines(source.content).length;
  const shared = {
    fqn,
    coordinates: source.coordinates,
    file: source.file,
    provenance: source.provenance,
    ...(source.stale ? { stale: true } : {}),
    ...(source.alternatives.length > 0 ? { alternatives: source.alternatives } : {}),
    degraded: source.degraded,
  };

  if (mode === "full") {
    return { mode, ...shared, content: source.content, startLine: 1, lineCount };
  }
  const sliced = sliceLines(source.content, opts.from!, opts.to!);
  return {
    mode,
    ...shared,
    lines: sliced.lines,
    startLine: sliced.startLine,
    endLine: sliced.endLine,
    lineCount,
    clamped: sliced.clamped,
  };
}
