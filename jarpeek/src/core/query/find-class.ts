/**
 * findClass: name → class hits, in the cheapest tier that answers.
 *
 * One streaming pass over class-kind records (member records are skipped in
 * flight): exact FQN, then suffix on full dot-segments, then simple name —
 * those tiers are collected fully — then fuzzy over simple names through a
 * bounded collector that keeps at most a small multiple of `limit` entries
 * and sorts once at the end. Hits carry the artifact's coordinates/version/
 * provenance, ordered by the manifest's artifacts position within a tier.
 */
import type { ClassHit, DeclKind, Provenance } from "../types.js";
import { fuzzyScore } from "../fuzzy.js";
import type { QueryContext } from "./context.js";
import { isClassKind, manifestOrder, mergedDegraded, servedStale } from "./outline.js";

export interface FindClassOptions {
  limit?: number;
}

export interface FindClassResult {
  hits: ClassHit[];
  degraded: string[];
}

const UNORDERED = Number.MAX_SAFE_INTEGER;

interface Candidate {
  fqn: string;
  coordinates: string;
  kind: DeclKind;
  /** Stream position; the stable tiebreaker after manifest position. */
  seq: number;
}

/** `query` equals the last N dot-segments of `fqn` (segment-aligned suffix). */
function suffixMatches(fqn: string, query: string): boolean {
  return query.includes(".") && (fqn === query || fqn.endsWith(`.${query}`));
}

/** Version = last `:`-segment of the coordinates; bare `jdk:` yields "". */
function versionOf(coordinates: string): string {
  const parts = coordinates.split(":");
  return parts[parts.length - 1] ?? "";
}

/**
 * Stream class records once, filling the exact/suffix/simple tiers fully and
 * the fuzzy tier through a bounded keep-`limit` collector.
 */
async function collectCandidates(
  ctx: QueryContext,
  query: string,
  limit: number,
  order: Map<string, number>,
): Promise<Candidate[][]> {
  const exact = new Map<string, Candidate>();
  const suffix = new Map<string, Candidate>();
  const simple = new Map<string, Candidate>();
  const fuzzy: Array<{ candidate: Candidate; score: number }> = [];
  let seq = 0;

  const byRank = (
    a: { candidate: Candidate; score: number },
    b: { candidate: Candidate; score: number },
  ): number =>
    b.score - a.score ||
    (order.get(a.candidate.coordinates) ?? UNORDERED) -
      (order.get(b.candidate.coordinates) ?? UNORDERED) ||
    a.candidate.seq - b.candidate.seq;

  await ctx.store.forEachRecord((record, safe) => {
    if (!isClassKind(record.kind)) return;
    const fqn = record.fqn;
    const simpleName = record.selector || fqn.slice(fqn.lastIndexOf(".") + 1);
    const coordinates = decodeURIComponent(safe);
    const key = `${coordinates} ${fqn}`;
    const seqNum = seq++;

    if (fqn === query) {
      exact.set(key, { fqn, coordinates, kind: record.kind, seq: seqNum });
    } else if (suffixMatches(fqn, query)) {
      suffix.set(key, { fqn, coordinates, kind: record.kind, seq: seqNum });
    } else if (simpleName === query) {
      simple.set(key, { fqn, coordinates, kind: record.kind, seq: seqNum });
    } else {
      const score = fuzzyScore(query, simpleName);
      if (score === null) return;
      if (fuzzy.some((e) => e.candidate.fqn === fqn && e.candidate.coordinates === coordinates)) return;
      fuzzy.push({ candidate: { fqn, coordinates, kind: record.kind, seq: seqNum }, score });
      if (fuzzy.length > Math.max(64, limit * 8)) {
        // bound memory: the survivors are provably ahead of everything dropped
        fuzzy.sort(byRank);
        fuzzy.length = limit;
      }
    }
  });

  fuzzy.sort(byRank);
  return [
    [...exact.values()],
    [...suffix.values()],
    [...simple.values()],
    fuzzy.map((e) => e.candidate),
  ];
}

/**
 * Find classes by exact FQN, segment-aligned suffix, simple name, or fuzzy
 * simple-name subsequence — in that order. Bootstraps the index first.
 */
export async function findClass(
  ctx: QueryContext,
  query: string,
  opts: FindClassOptions = {},
): Promise<FindClassResult> {
  const limit = opts.limit ?? 20;
  await ctx.ensureReady();

  // read once: tier ordering, fuzzy pruning, and provenance all use it
  const manifest = await ctx.manifest();
  const order = manifestOrder(manifest);
  const provenanceByCoordinates = new Map<string, Provenance>();
  for (const artifact of manifest?.artifacts ?? []) {
    provenanceByCoordinates.set(artifact.coordinates, artifact.provenance);
  }

  const tiers = await collectCandidates(ctx, query, limit, order);

  // shards the manifest does not list (e.g. manually injected): one lookup
  // per distinct fqn recovers their shard metadata
  const unmapped = tiers.flat().filter((c) => !provenanceByCoordinates.has(c.coordinates));
  for (const fqn of new Set(unmapped.map((c) => c.fqn))) {
    for (const hit of await ctx.store.lookup(fqn)) {
      if (!provenanceByCoordinates.has(hit.meta.coordinates)) {
        provenanceByCoordinates.set(hit.meta.coordinates, hit.meta.provenance);
      }
    }
  }

  const byManifestPosition = (a: Candidate, b: Candidate): number =>
    (order.get(a.coordinates) ?? UNORDERED) - (order.get(b.coordinates) ?? UNORDERED) || a.seq - b.seq;

  const hits: ClassHit[] = tiers.flatMap((tier, tierIndex) =>
    (tierIndex === 3 ? tier.slice(0, limit) : [...tier].sort(byManifestPosition)).map(
      (candidate): ClassHit => ({
        fqn: candidate.fqn,
        coordinates: candidate.coordinates,
        version: versionOf(candidate.coordinates),
        kind: candidate.kind,
        provenance: provenanceByCoordinates.get(candidate.coordinates) ?? "signature",
      }),
    ),
  );

  const stale = await servedStale(ctx);
  return { hits, degraded: mergedDegraded(ctx, stale ? ["stale index served"] : []) };
}
