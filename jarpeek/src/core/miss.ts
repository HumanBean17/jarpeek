/**
 * The miss protocol: what to do when a lookup found nothing.
 *
 * Misses are expected traffic for an agent exploring an unfamiliar dependency
 * set, so they get a decision ladder instead of an error message:
 * 1. suggest — fuzzy/simple-name candidates for the class actually meant;
 * 2. JDK routing — `java.*` & friends trigger JDK indexing, then one retry;
 * 3. staleness — a stale manifest re-resolves, then one retry;
 * 4. negative — say what was searched and that remote artifact search is a
 *    planned extension, so the agent can stop and ask the user instead.
 */
import { indexArtifacts } from "../index/indexer.js";
import { isStale } from "../index/manifest.js";
import { resolveJdk } from "../resolver/jdk.js";
import type { ResolveDependenciesOptions } from "../resolver/index.js";
import type { ClassHit, Provenance } from "./types.js";
import type { QueryContext } from "./query/context.js";
import { findClass } from "./query/find-class.js";
import { LookupMissError, orderedLookup, type ArtifactHit } from "./query/outline.js";

/** Namespaces owned by the JDK pseudo-artifact. */
const JDK_NAMESPACES = [
  "java.",
  "javax.",
  "jdk.",
  "sun.",
  "org.w3c.dom.",
  "org.xml.sax.",
  "org.ietf.jgss.",
] as const;

export type MissResult =
  | { found: true; via: "fuzzy-candidates"; hits: ClassHit[] }
  | { found: true; via: "jdk" | "re-resolve"; coordinates: string; provenance: Provenance }
  | { found: false; via: "negative"; searchedArtifacts: string[]; note: string };

export interface HandleMissOptions {
  /** Injectable resolvers (tests); the JDK resolver is the only one consumed. */
  resolvers?: ResolveDependenciesOptions;
  onProgress?: (msg: string) => void;
}

const NEGATIVE_NOTE = "not found in indexed artifacts; remote artifact search is a planned extension";
const CACHE_SCAN_NOTE = "cache-scan: resolution degraded to local machine caches";

/** One retry of the original class lookup; a repeat miss returns undefined. */
async function retryLookup(ctx: QueryContext, fqn: string): Promise<ArtifactHit | undefined> {
  try {
    return (await orderedLookup(ctx, fqn)).winner;
  } catch (e) {
    if (e instanceof LookupMissError) return undefined;
    throw e;
  }
}

/**
 * Run the four-step miss protocol for a lookup or query failure. Class-shaped
 * errors (`LookupMissError`) walk every step; anything else skips straight to
 * the negative answer.
 */
export async function handleMiss(
  ctx: QueryContext,
  err: LookupMissError | { query: string },
  opts: HandleMissOptions = {},
): Promise<MissResult> {
  const fqn = err instanceof LookupMissError ? err.fqn : undefined;

  if (fqn !== undefined) {
    // 1. suggestions: the simple name finds the class under another package
    const candidates = await findClass(ctx, fqn.slice(fqn.lastIndexOf(".") + 1));
    if (candidates.hits.length > 0) {
      return { found: true, via: "fuzzy-candidates", hits: candidates.hits };
    }

    // 2. JDK namespaces: index the JDK pseudo-artifact if it is missing, retry once
    if ((JDK_NAMESPACES as readonly string[]).some((ns) => fqn.startsWith(ns))) {
      const manifest = await ctx.manifest();
      const jdkIndexed = (manifest?.artifacts ?? []).some((artifact) => artifact.kind === "jdk");
      if (!jdkIndexed) {
        const resolve = opts.resolvers?.jdk ?? ((o = {}) => resolveJdk({ ...o, cacheDir: ctx.cacheDir }));
        const jdk = await resolve();
        if (jdk.artifact !== null) {
          // re-index the full set so the manifest keeps listing every artifact
          await indexArtifacts(ctx.projectRoot, [...(manifest?.artifacts ?? []), jdk.artifact], {
            store: ctx.store,
            onProgress: opts.onProgress,
          });
        }
      }
      const hit = await retryLookup(ctx, fqn);
      if (hit !== undefined) {
        return { found: true, via: "jdk", coordinates: hit.meta.coordinates, provenance: hit.meta.provenance };
      }
    }

    // 3. staleness: the build files moved since the last resolve — redo it, retry once
    const manifest = await ctx.manifest();
    if (manifest !== null && (await isStale(ctx.projectRoot, manifest))) {
      await ctx.ensureReady();
      const hit = await retryLookup(ctx, fqn);
      if (hit !== undefined) {
        return { found: true, via: "re-resolve", coordinates: hit.meta.coordinates, provenance: hit.meta.provenance };
      }
    }
  }

  // 4. negative: report the searched set honestly and stop
  const manifest = await ctx.manifest();
  const searchedArtifacts = (manifest?.artifacts ?? []).map((artifact) => artifact.coordinates);
  if (ctx.bootstrapWarnings().includes("degraded-to-cache-scan")) {
    searchedArtifacts.push(CACHE_SCAN_NOTE);
  }
  return { found: false, via: "negative", searchedArtifacts, note: NEGATIVE_NOTE };
}
