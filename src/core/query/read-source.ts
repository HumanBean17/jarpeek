/**
 * readSource: source text for one class, in the size the caller asked for.
 *
 * `outline` (default) reuses the outline rows. `full` resolves the located
 * winner's best source — module sourceDir file, sources-jar entry (JDK
 * src.zip included), or a whole-class CFR decompile for binary-only
 * artifacts — and `lines` slices that content. The located entry names the
 * bytes for every rung: no re-listing, no suffix search. When no real source
 * can be produced (JDK classes where decompilation is out of scope, or a
 * decompile that failed) the signature rows render as text under provenance
 * "signature" with a header note saying why. Lookup misses throw
 * LookupMissError like outline does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Declaration, DependencyArtifact, Provenance } from "../types.js";
import type { DecompileResult } from "../../decompile/cfr.js";
import { listZipEntries, readTextEntry } from "../../parse/zip.js";
import { sliceLines, splitLines } from "../../util/lines.js";
import type { QueryContext } from "./context.js";
import { locateClass, type LocateResult } from "./locate.js";
import { mergedDegraded, outline, servedStale, type OutlineResult } from "./outline.js";

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

export interface ResolvedContent {
  /** Winner artifact metadata (readMember derives degradation reasons from it). */
  meta: DependencyArtifact;
  /** The winner's records declaring `fqn` (class row plus members). */
  records: Declaration[];
  coordinates: string;
  file: string;
  provenance: Provenance;
  content: string;
  stale: boolean;
  alternatives: Array<{ coordinates: string }>;
  degraded: string[];
  /** Raw outcome when a decompile was attempted — present even when it degraded. */
  decompile?: DecompileResult;
  /** The header note embedded in a signature fallback's content. */
  signatureNote?: string;
}

const JDK_NOTE = "signatures only (jdk: decompilation is out of scope)";

/**
 * The located winner's best whole-file source text, with the provenance it
 * came from. Records and entry are parsed from the very content this ladder
 * serves (or, on the decompile rungs, from the same class entry), so no
 * misalignment check exists — misalignment is impossible by construction.
 * Exported for readMember, which reuses the whole resolution ladder.
 */
export async function resolveContent(ctx: QueryContext, fqn: string): Promise<ResolvedContent> {
  await ctx.ensureReady();
  const { winner, alternatives, degraded: locateDegraded }: LocateResult =
    await locateClass(ctx, fqn, { includeNested: false });
  const meta = winner.artifact;
  // the internal name the decompiler keys on: the located entry minus .class
  const internalName = winner.entry.replace(/\.class$/, "");
  const stale = await servedStale(ctx);
  const degraded = await mergedDegraded(ctx, [
    ...(stale ? ["stale index served"] : []),
    ...locateDegraded,
  ]);

  const resolved = (file: string, provenance: Provenance, content: string): ResolvedContent => ({
    meta,
    records: winner.records,
    coordinates: meta.coordinates,
    file,
    provenance,
    content,
    stale,
    alternatives,
    degraded,
  });

  const signatureFallback = (note: string, extra: Partial<ResolvedContent> = {}): ResolvedContent => ({
    ...resolved(winner.entry, "signature", [
      note,
      ...winner.records.map((record) => record.signature),
    ].join("\n")),
    signatureNote: note,
    ...extra,
  });

  // 1. module sourceDir: the located entry is the sourceDir-relative path
  if (meta.sourceDir) {
    try {
      return resolved(winner.entry, "source", readFileSync(join(meta.sourceDir, winner.entry), "utf8"));
    } catch {
      // unreadable path — fall through to the next source
    }
  }

  // 2. sources jar: the EXACT located entry (external sources or the JDK's
  // src.zip — same zip reader; locate already searched, no suffix logic here)
  if (meta.sourcesJar) {
    try {
      const zipEntry = (await listZipEntries(meta.sourcesJar)).find((e) => e.name === winner.entry);
      if (zipEntry !== undefined) {
        return resolved(winner.entry, "source", await readTextEntry(meta.sourcesJar, zipEntry));
      }
    } catch {
      // unreadable archive or entry — fall through
    }
  }

  // 3. binary jar: whole-class decompile (skipped where decompilation is out of scope)
  if (meta.binaryJar && !meta.noDecompile) {
    const result = await ctx.decompiler(meta.coordinates, meta.binaryJar, internalName);
    if (result.provenance === "decompiled") {
      return resolved(`${internalName}.java (decompiled)`, "decompiled", result.source);
    }
    const detail = "reason" in result ? `${result.reason}${result.detail ? `: ${result.detail}` : ""}` : "unknown";
    return signatureFallback(`signatures only (decompilation failed: ${detail})`, { decompile: result });
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
