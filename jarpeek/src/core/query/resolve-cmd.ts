/**
 * resolveNow: force a resolve+index pass, freshness be damned. Where the
 * context's `ensureReady` short-circuits on a fresh manifest, this always
 * re-runs the resolver cascade and rewrites the index — the `resolve`
 * command's backing, and the manual escape hatch when an agent knows the
 * build changed under a manifest that still hashes clean.
 */
import { indexArtifacts, type IndexResult } from "../../index/indexer.js";
import { resolveDependencies, type ResolveDependenciesOptions } from "../../resolver/index.js";
import type { QueryContext } from "./context.js";

export interface ResolveNowOptions {
  /** Injectable resolvers; defaults are the real cascade. */
  resolvers?: ResolveDependenciesOptions;
  onProgress?: (msg: string) => void;
}

export type ResolveNowResult = IndexResult & {
  warnings: string[];
  degraded: Array<{ from: "gradle" | "maven"; reason: string }>;
};

/** Re-resolve and re-index unconditionally, into the context's store. */
export async function resolveNow(ctx: QueryContext, opts: ResolveNowOptions = {}): Promise<ResolveNowResult> {
  const resolution = await resolveDependencies(ctx.projectRoot, opts.resolvers);
  const result = await indexArtifacts(ctx.projectRoot, resolution.artifacts, {
    store: ctx.store,
    onProgress: opts.onProgress,
  });
  return {
    ...result,
    warnings: [...new Set([...resolution.warnings, ...result.warnings])],
    degraded: resolution.degraded,
  };
}
