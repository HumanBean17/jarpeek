/**
 * searchSymbols: symbol search across every indexed artifact in one
 * streaming pass. Ranking is tiered like findClass — exact selector, then
 * prefix, then fuzzy subsequence — so a precise query surfaces the declared
 * member first and a loose one still finds it. The exact and prefix tiers
 * are collected fully; the fuzzy tier flows through a bounded keep-`limit`
 * collector (tiers dominate ranking, so the bounded top of the fuzzy bucket
 * is provably the same top a full sort would keep). Signatures are truncated
 * to keep rows cheap; the kind filter and the manifest scope run in flight,
 * before any tiering.
 */
import type { DeclKind } from "../types.js";
import { fuzzyScore } from "../fuzzy.js";
import type { QueryContext } from "./context.js";
import { manifestOrder, manifestScope, mergedDegraded, servedStale } from "./outline.js";

export interface SymbolRow {
  selector: string;
  fqn: string;
  kind: DeclKind;
  coordinates: string;
  signature: string;
}

export interface SymbolResult {
  rows: SymbolRow[];
  degraded: string[];
}

export interface SearchSymbolsOptions {
  limit?: number;
  kind?: DeclKind;
}

const DEFAULT_LIMIT = 50;
const SIGNATURE_MAX_CHARS = 120;
const UNORDERED = Number.MAX_SAFE_INTEGER;

interface ScoredRow {
  row: SymbolRow;
  /** 0 exact, 1 prefix, 2 fuzzy — the primary sort key. */
  tier: number;
  score: number;
  order: number;
  seq: number;
}

function truncateSignature(signature: string): string {
  return signature.length > SIGNATURE_MAX_CHARS
    ? signature.slice(0, SIGNATURE_MAX_CHARS) + "…"
    : signature;
}

/**
 * Find declarations by selector: exact matches first, then prefix, then
 * fuzzy (`fuzzyScore`), manifest position and stream order breaking ties.
 */
export async function searchSymbols(
  ctx: QueryContext,
  query: string,
  opts: SearchSymbolsOptions = {},
): Promise<SymbolResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  await ctx.ensureReady();
  const manifest = await ctx.manifest();
  const order = manifestOrder(manifest);
  // a manifest scopes the user-global cache store to this project's artifacts
  const scope = manifestScope(manifest);

  /** Tier 0/1: collected fully. Tier 2 lands in `fuzzy`, bounded below. */
  const collected: ScoredRow[] = [];
  const fuzzy: ScoredRow[] = [];
  let seq = 0;

  const byRank = (a: ScoredRow, b: ScoredRow): number =>
    b.score - a.score || a.order - b.order || a.seq - b.seq;

  await ctx.store.forEachRecord((record, safe) => {
    if (opts.kind !== undefined && record.kind !== opts.kind) return;
    const score = fuzzyScore(query, record.selector);
    if (score === null) return;
    const coordinates = decodeURIComponent(safe);
    if (scope !== null && !scope.has(coordinates)) return;
    const tier = record.selector === query ? 0 : record.selector.startsWith(query) ? 1 : 2;
    const scored: ScoredRow = {
      row: {
        selector: record.selector,
        fqn: record.fqn,
        kind: record.kind,
        coordinates,
        signature: truncateSignature(record.signature),
      },
      tier,
      score,
      order: order.get(coordinates) ?? UNORDERED,
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
  });

  fuzzy.sort(byRank);
  const scored = [...collected, ...fuzzy].sort(
    (a, b) => a.tier - b.tier || b.score - a.score || a.order - b.order || a.seq - b.seq,
  );

  const stale = await servedStale(ctx);
  return { rows: scored.slice(0, limit).map((s) => s.row), degraded: mergedDegraded(ctx, stale ? ["stale index served"] : []) };
}
