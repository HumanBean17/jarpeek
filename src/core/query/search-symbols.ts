/**
 * searchSymbols: member-name search scoped to ONE artifact. The artifact
 * query resolves through the same contract read_resource uses (exact
 * coordinates, else a unique artifact-id segment), that single backing is
 * parsed on demand (memoized per coordinates+stamp inside recordsForArtifact),
 * and the v1 tier ladder runs over its records alone: exact selector, then
 * prefix, then fuzzy (`fuzzyScore`) — stream order replaces manifest order in
 * the tiebreaks because only one artifact is streamed. Signatures truncate at
 * 120 chars and every row carries the parse's provenance, so a
 * signature-only hit is never mistaken for sourced.
 *
 * Unknown artifacts are exit-path answers, not errors: a did-you-mean line
 * built from the manifest's artifact ids (fuzzy-ranked, top 3). An artifact
 * that parsed to zero records degrades with its unreadable string instead.
 */
import type { DeclKind, DependencyArtifact, Provenance } from "../types.js";
import { fuzzyScore } from "../fuzzy.js";
import type { QueryContext } from "./context.js";
import { recordsForArtifact } from "./locate.js";
import { mergedDegraded, servedStale } from "./outline.js";
import { resolveArtifactQuery } from "./read-resource.js";

export interface SymbolRow {
  selector: string;
  fqn: string;
  kind: DeclKind;
  coordinates: string;
  /** How the declaring artifact was indexed — signature rows are derived, not source. */
  provenance: Provenance;
  signature: string;
}

export interface SymbolResult {
  rows: SymbolRow[];
  degraded: string[];
}

export interface SearchSymbolsOptions {
  /** REQUIRED: g:a:v coordinates or a unique artifact id — the global scan is gone. */
  artifact: string;
  limit?: number;
  kind?: DeclKind;
}

const DEFAULT_LIMIT = 50;
const SIGNATURE_MAX_CHARS = 120;

interface ScoredRow {
  row: SymbolRow;
  /** 0 exact, 1 prefix, 2 fuzzy — the primary sort key. */
  tier: number;
  score: number;
  /** Stream position within the one artifact — the stable final tiebreak. */
  seq: number;
}

function truncateSignature(signature: string): string {
  return signature.length > SIGNATURE_MAX_CHARS
    ? signature.slice(0, SIGNATURE_MAX_CHARS) + "…"
    : signature;
}

/**
 * The manifest's artifact ids (the `a` of each `g:a:v`), fuzzy-ranked against
 * the failed query — the did-you-mean half of an unknown-artifact answer.
 */
async function closestArtifactIds(ctx: QueryContext, query: string): Promise<string[]> {
  const artifacts = await ctx.artifacts();
  const scored: Array<{ id: string; score: number; index: number }> = [];
  artifacts.forEach((artifact, index) => {
    const id = artifact.coordinates.split(":")[1] ?? artifact.coordinates;
    const score = fuzzyScore(query, id);
    if (score !== null) scored.push({ id, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, 3).map((entry) => entry.id);
}

/**
 * Find declarations by selector in ONE artifact: exact matches first, then
 * prefix, then fuzzy, stream order breaking ties.
 */
export async function searchSymbols(
  ctx: QueryContext,
  query: string,
  opts: SearchSymbolsOptions,
): Promise<SymbolResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  await ctx.ensureReady();

  let artifact: DependencyArtifact;
  try {
    artifact = await resolveArtifactQuery(ctx, opts.artifact);
  } catch {
    // an unknown (or ambiguous) artifact id is a miss with suggestions, not
    // an error — same exit-path contract as every other miss
    const closest = await closestArtifactIds(ctx, opts.artifact);
    const suggestions = closest.length > 0 ? closest.join(", ") : "(no artifacts resolved)";
    return {
      rows: [],
      degraded: [`unknown artifact "${opts.artifact}" — closest: ${suggestions}`],
    };
  }

  const { records, provenance, unreadable } = await recordsForArtifact(ctx, artifact);
  if (records.length === 0) {
    // nothing parsed (unreadable backing, or every entry failed): say so via
    // the same channel, with whatever the parse layer aggregated
    return {
      rows: [],
      degraded: [unreadable ?? `${artifact.coordinates} parsed to no declarations`],
    };
  }

  /** Tier 0/1: collected fully. Tier 2 lands in `fuzzy`, bounded below. */
  const collected: ScoredRow[] = [];
  const fuzzy: ScoredRow[] = [];
  let seq = 0;

  const byRank = (a: ScoredRow, b: ScoredRow): number => b.score - a.score || a.seq - b.seq;

  for (const record of records) {
    if (opts.kind !== undefined && record.kind !== opts.kind) continue;
    const score = fuzzyScore(query, record.selector);
    if (score === null) continue;
    const tier = record.selector === query ? 0 : record.selector.startsWith(query) ? 1 : 2;
    const scored: ScoredRow = {
      row: {
        selector: record.selector,
        fqn: record.fqn,
        kind: record.kind,
        coordinates: artifact.coordinates,
        provenance,
        signature: truncateSignature(record.signature),
      },
      tier,
      score,
      seq: seq++,
    };
    if (tier < 2) {
      collected.push(scored);
    } else {
      fuzzy.push(scored);
      if (fuzzy.length > Math.max(64, limit * 8)) {
        // bound memory: the survivors are provably ahead of everything dropped
        fuzzy.sort(byRank);
        fuzzy.length = limit;
      }
    }
  }

  fuzzy.sort(byRank);
  const scored = [...collected, ...fuzzy].sort(
    (a, b) => a.tier - b.tier || b.score - a.score || a.seq - b.seq,
  );

  const stale = await servedStale(ctx);
  return {
    rows: scored.slice(0, limit).map((s) => s.row),
    degraded: await mergedDegraded(ctx, [
      ...(stale ? ["stale index served"] : []),
      ...(unreadable !== undefined ? [unreadable] : []),
    ]),
  };
}
