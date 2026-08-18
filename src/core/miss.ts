/**
 * The miss protocol: what to do when a lookup found nothing.
 *
 * Misses are expected traffic for an agent exploring an unfamiliar dependency
 * set, so they get a decision ladder instead of an error message — two steps
 * now, because the manifest is the only state: ensureReady already
 * re-resolves on staleness, and there is no index to be missing.
 * 1. suggest — fuzzy/simple-name candidates for the class actually meant;
 * 2. negative — say what was searched and that remote artifact search is a
 *    planned extension, so the agent can stop and ask the user instead.
 */
import type { ClassHit } from "./types.js";
import type { QueryContext } from "./query/context.js";
import { findClass } from "./query/find-class.js";
import { LookupMissError } from "./query/outline.js";

export type MissResult =
  | { found: true; via: "fuzzy-candidates"; hits: ClassHit[] }
  | {
      found: false;
      via: "negative";
      searchedArtifacts: string[];
      note: string;
      /**
       * Why the answer may be hollow — a failed auto-resolve above all: spec
       * decision #1 says a failed resolve answers as a miss carrying its
       * reason, so the negative pulls the same bootstrap-warnings channel the
       * hits path surfaces through `degraded`.
       */
      degraded: string[];
    };

/** Nothing to inject anymore: suggestions read the same listings, negatives read the manifest. */
export interface HandleMissOptions {}

const NEGATIVE_NOTE = "not found in resolved artifacts; remote artifact search is a planned extension";
const CACHE_SCAN_NOTE = "cache-scan: resolution degraded to local machine caches";

/**
 * Run the two-step miss protocol for a lookup or query failure. Class-shaped
 * errors (`LookupMissError`) get the suggestion step; anything else goes
 * straight to the negative answer.
 */
export async function handleMiss(
  ctx: QueryContext,
  err: LookupMissError | { query: string },
  _opts: HandleMissOptions = {},
): Promise<MissResult> {
  const fqn = err instanceof LookupMissError ? err.fqn : undefined;

  if (fqn !== undefined) {
    // 1. suggestions: the simple name finds the class under another package
    const candidates = await findClass(ctx, fqn.slice(fqn.lastIndexOf(".") + 1));
    if (candidates.hits.length > 0) {
      return { found: true, via: "fuzzy-candidates", hits: candidates.hits };
    }
  }

  // 2. negative: report the searched set honestly and stop
  const manifest = await ctx.manifest();
  const searchedArtifacts = (manifest?.artifacts ?? []).map((artifact) => artifact.coordinates);
  const degraded = [...new Set(await ctx.bootstrapWarnings())];
  if (degraded.includes("degraded-to-cache-scan")) {
    searchedArtifacts.push(CACHE_SCAN_NOTE);
  }
  return { found: false, via: "negative", searchedArtifacts, note: NEGATIVE_NOTE, degraded };
}
