/**
 * Outline: the frugal first look at a class — its declaration rows without
 * any source text.
 *
 * Lookup misses are protocol, not errors to print: `LookupMissError` carries
 * the fqn so the miss layer (Task 18) can suggest alternatives. Shards
 * declaring the same fqn are ordered by the manifest's artifacts position —
 * first occurrence is the winner, the rest become `alternatives`.
 */
import type { Declaration, DeclKind, DependencyArtifact, Provenance, Visibility } from "../types.js";
import { isStale, type Manifest } from "../../index/manifest.js";
import type { QueryContext } from "./context.js";

/** Declaration kinds that name a type (vs members of one). */
export const CLASS_KINDS: readonly DeclKind[] = [
  "class",
  "interface",
  "enum",
  "record",
  "annotation",
  "object",
];

export const isClassKind = (kind: DeclKind): boolean =>
  (CLASS_KINDS as readonly string[]).includes(kind);

/** Thrown by outline/readSource when no indexed artifact declares `fqn`. */
export class LookupMissError extends Error {
  constructor(public readonly fqn: string) {
    super(`no indexed class for ${fqn}`);
    this.name = "LookupMissError";
  }
}

export interface ArtifactHit {
  safe: string;
  meta: DependencyArtifact;
  /** Only the records declaring the queried fqn (a shard holds the whole artifact). */
  records: Declaration[];
}

export interface OrderedLookup {
  winner: ArtifactHit;
  alternatives: Array<{ coordinates: string }>;
  /** Set when the winner came from shards the manifest no longer lists. */
  degraded: string[];
}

export interface OutlineOptions {
  kind?: DeclKind;
  visibility?: Visibility;
}

export interface OutlineResult {
  fqn: string;
  coordinates: string;
  provenance: Provenance;
  /** Present (and true) only when a stale index had to be served. */
  stale?: boolean;
  rows: Declaration[];
  alternatives?: Array<{ coordinates: string }>;
  degraded: string[];
}

const UNORDERED = Number.MAX_SAFE_INTEGER;

/** Warning carried when a lookup had to be answered from out-of-manifest shards. */
export const OUT_OF_MANIFEST_WARNING = "artifact no longer in dependency set";

/** coordinates → position in the manifest's artifacts array; first occurrence wins. */
export function manifestOrder(manifest: Manifest | null): Map<string, number> {
  const order = new Map<string, number>();
  (manifest?.artifacts ?? []).forEach((artifact, index) => {
    if (!order.has(artifact.coordinates)) order.set(artifact.coordinates, index);
  });
  return order;
}

/**
 * The manifest's artifact coordinates as a membership filter, or null only
 * when no manifest exists — the cache store is user-global and never pruned,
 * so with a manifest present queries serve only its artifacts. A manifest
 * that lists ZERO artifacts still scopes: it says the resolved set is empty,
 * so foreign shards are excluded (and any fallback serving is flagged), not
 * silently treated as fair game.
 */
export function manifestScope(manifest: Manifest | null): Set<string> | null {
  if (manifest === null) return null;
  return new Set(manifest.artifacts.map((artifact) => artifact.coordinates));
}

/**
 * All shards declaring `fqn`, ordered by manifest artifacts position. When a
 * manifest scopes the index, shards it does not list are excluded — unless
 * they are the ONLY answer, in which case they are served with the
 * `OUT_OF_MANIFEST_WARNING` degradation (the jars still answer; the flag says
 * the dependency set moved on). Empty → LookupMissError.
 */
export async function orderedLookup(ctx: QueryContext, fqn: string): Promise<OrderedLookup> {
  const hits = await ctx.store.lookup(fqn);
  if (hits.length === 0) {
    throw new LookupMissError(fqn);
  }
  const manifest = await ctx.manifest();
  const order = manifestOrder(manifest);
  const scope = manifestScope(manifest);
  const scoped = scope === null ? hits : hits.filter((hit) => scope.has(hit.meta.coordinates));
  const served = scoped.length > 0 ? scoped : hits;
  const ranked = served
    .map((hit, index) => ({ hit, index }))
    .sort(
      (a, b) =>
        (order.get(a.hit.meta.coordinates) ?? UNORDERED) -
          (order.get(b.hit.meta.coordinates) ?? UNORDERED) ||
        a.index - b.index,
    )
    .map(({ hit }) => ({ ...hit, records: hit.records.filter((record) => record.fqn === fqn) }));
  return {
    winner: ranked[0]!,
    alternatives: ranked.slice(1).map((hit) => ({ coordinates: hit.meta.coordinates })),
    degraded: scoped.length === 0 ? [OUT_OF_MANIFEST_WARNING] : [],
  };
}

/** True when the served manifest no longer matches the build files / artifact paths. */
export async function servedStale(ctx: QueryContext): Promise<boolean> {
  const manifest = await ctx.manifest();
  return manifest !== null && isStale(ctx.projectRoot, manifest);
}

/** Merge bootstrap warnings with per-call degradation, without duplicates. */
export async function mergedDegraded(ctx: QueryContext, extra: string[]): Promise<string[]> {
  return [...new Set([...(await ctx.bootstrapWarnings()), ...extra])];
}

/**
 * Class-level rows of the artifact's directly nested classes (`fqn` is their
 * prefix). Nested lookups obey the same manifest scope as the winner lookup:
 * a stale shard's declarations never leak into a newer winner's outline
 * unflagged — when no in-scope shard declares the nested class, the
 * out-of-manifest shard serves it with the `OUT_OF_MANIFEST_WARNING`.
 */
async function nestedClassRows(
  winner: ArtifactHit,
  ctx: QueryContext,
  fqn: string,
  scope: Set<string> | null,
): Promise<{ rows: Declaration[]; degraded: string[] }> {
  const prefix = `${fqn}.`;
  const nestedFqns: string[] = [];
  for (const other of (await ctx.store.readDirectory()).keys()) {
    if (other.startsWith(prefix) && !other.slice(prefix.length).includes(".")) {
      nestedFqns.push(other);
    }
  }
  const rows: Declaration[] = [];
  let outOfManifest = false;
  for (const nestedFqn of nestedFqns) {
    const shards = await ctx.store.lookup(nestedFqn);
    if (shards.length === 0) continue;
    const scoped = scope === null ? shards : shards.filter((hit) => scope.has(hit.meta.coordinates));
    if (scoped.length === 0) outOfManifest = true;
    const pool = scoped.length > 0 ? scoped : shards;
    const shard = pool.find((hit) => hit.safe === winner.safe) ?? pool[0]!;
    rows.push(...shard.records.filter((record) => record.fqn === nestedFqn && isClassKind(record.kind)));
  }
  return { rows, degraded: outOfManifest ? [OUT_OF_MANIFEST_WARNING] : [] };
}

/**
 * Declaration rows for `fqn`: the winner's own records (its class row plus
 * members) plus its directly nested class rows, filtered by kind/visibility
 * when given.
 */
export async function outline(
  ctx: QueryContext,
  fqn: string,
  opts: OutlineOptions = {},
): Promise<OutlineResult> {
  await ctx.ensureReady();
  const { winner, alternatives, degraded: lookupDegraded } = await orderedLookup(ctx, fqn);
  const nested = await nestedClassRows(winner, ctx, fqn, manifestScope(await ctx.manifest()));
  const rows = [...winner.records, ...nested.rows].filter(
    (row) =>
      (opts.kind === undefined || row.kind === opts.kind) &&
      (opts.visibility === undefined || row.visibility === opts.visibility),
  );
  const stale = await servedStale(ctx);
  return {
    fqn,
    coordinates: winner.meta.coordinates,
    provenance: winner.meta.provenance,
    ...(stale ? { stale: true } : {}),
    rows,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    degraded: await mergedDegraded(ctx, [
      ...(stale ? ["stale index served"] : []),
      ...lookupDegraded,
      ...nested.degraded,
    ]),
  };
}
