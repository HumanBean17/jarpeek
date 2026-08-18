/**
 * Outline: the frugal first look at a class — its declaration rows without
 * any source text.
 *
 * Lookup is listing-backed (Task 5): `locateClass` walks the manifest's
 * artifacts in order, and the first whose backing declares the fqn is parsed
 * from exactly one file — its own row, members, and directly nested class
 * rows come out of that parse. Later hits become `alternatives`; the store's
 * manifest ordering/shaping helpers stay exported for search-symbols until
 * Task 9 retires their last importer. Lookup misses are protocol, not errors
 * to print: `LookupMissError` carries the fqn so the miss layer can suggest
 * alternatives.
 */
import type { Declaration, DeclKind, Provenance, Visibility } from "../types.js";
import { isStale, type Manifest } from "../../index/manifest.js";
import type { QueryContext } from "./context.js";
import { locateClass } from "./locate.js";

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

/** Thrown by outline/readSource when no listed artifact declares `fqn`. */
export class LookupMissError extends Error {
  constructor(public readonly fqn: string) {
    super(`no indexed class for ${fqn}`);
    this.name = "LookupMissError";
  }
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

/**
 * coordinates → position in the manifest's artifacts array; first occurrence
 * wins. (Store-era helper kept for search-symbols, Task 9's last importer.)
 */
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
 * so with a manifest present queries serve only its artifacts. (Store-era
 * helper kept for search-symbols, Task 9's last importer.)
 */
export function manifestScope(manifest: Manifest | null): Set<string> | null {
  if (manifest === null) return null;
  return new Set(manifest.artifacts.map((artifact) => artifact.coordinates));
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
 * Declaration rows for `fqn`: the located winner's records (class row,
 * members, nested class rows) filtered by kind/visibility when given.
 */
export async function outline(
  ctx: QueryContext,
  fqn: string,
  opts: OutlineOptions = {},
): Promise<OutlineResult> {
  await ctx.ensureReady();
  const { winner, alternatives, degraded: locateDegraded } = await locateClass(ctx, fqn);
  const rows = winner.records.filter(
    (row) =>
      (opts.kind === undefined || row.kind === opts.kind) &&
      (opts.visibility === undefined || row.visibility === opts.visibility),
  );
  const stale = await servedStale(ctx);
  return {
    fqn,
    coordinates: winner.artifact.coordinates,
    provenance: winner.provenance,
    ...(stale ? { stale: true } : {}),
    rows,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    degraded: await mergedDegraded(ctx, [
      ...(stale ? ["stale index served"] : []),
      ...locateDegraded,
    ]),
  };
}
