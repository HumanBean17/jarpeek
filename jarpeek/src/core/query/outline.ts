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

/** coordinates → position in the manifest's artifacts array; first occurrence wins. */
export function manifestOrder(manifest: Manifest | null): Map<string, number> {
  const order = new Map<string, number>();
  (manifest?.artifacts ?? []).forEach((artifact, index) => {
    if (!order.has(artifact.coordinates)) order.set(artifact.coordinates, index);
  });
  return order;
}

/**
 * All shards declaring `fqn`, ordered by manifest artifacts position (shards
 * the manifest does not know — e.g. manually injected ones — sort last,
 * keeping lookup order). Empty → LookupMissError.
 */
export async function orderedLookup(ctx: QueryContext, fqn: string): Promise<OrderedLookup> {
  const hits = await ctx.store.lookup(fqn);
  if (hits.length === 0) {
    throw new LookupMissError(fqn);
  }
  const order = manifestOrder(await ctx.manifest());
  const ranked = hits
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
  };
}

/** True when the served manifest no longer matches the build files / artifact paths. */
export async function servedStale(ctx: QueryContext): Promise<boolean> {
  const manifest = await ctx.manifest();
  return manifest !== null && isStale(ctx.projectRoot, manifest);
}

/** Merge bootstrap warnings with per-call degradation, without duplicates. */
export function mergedDegraded(ctx: QueryContext, extra: string[]): string[] {
  return [...new Set([...ctx.bootstrapWarnings(), ...extra])];
}

/** Class-level rows of the artifact's directly nested classes (`fqn` is their prefix). */
async function nestedClassRows(winner: ArtifactHit, ctx: QueryContext, fqn: string): Promise<Declaration[]> {
  const prefix = `${fqn}.`;
  const nestedFqns: string[] = [];
  for (const other of (await ctx.store.readDirectory()).keys()) {
    if (other.startsWith(prefix) && !other.slice(prefix.length).includes(".")) {
      nestedFqns.push(other);
    }
  }
  const rows: Declaration[] = [];
  for (const nestedFqn of nestedFqns) {
    const shards = await ctx.store.lookup(nestedFqn);
    if (shards.length === 0) continue;
    const shard = shards.find((hit) => hit.safe === winner.safe) ?? shards[0]!;
    rows.push(...shard.records.filter((record) => record.fqn === nestedFqn && isClassKind(record.kind)));
  }
  return rows;
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
  const { winner, alternatives } = await orderedLookup(ctx, fqn);
  const rows = [...winner.records, ...(await nestedClassRows(winner, ctx, fqn))].filter(
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
    degraded: mergedDegraded(ctx, stale ? ["stale index served"] : []),
  };
}
