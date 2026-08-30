/**
 * resolveNow: force a resolve pass and rewrite the manifest, freshness be
 * damned. Where the context's `ensureReady` short-circuits on a fresh
 * manifest — and refuses to adopt a cache-scan result — this always re-runs
 * the full gradle → maven → cache-scan cascade and writes whatever it got,
 * flagged, so the explicit `resolve` command is the escape hatch when an
 * agent knows the build changed under a manifest that still hashes clean,
 * and the only writer of a heuristic manifest there is.
 *
 * Resolution only: no indexing runs here (or anywhere else), so the result
 * reports counts and wall-clock, not per-artifact progress.
 */
import {
  computeDependencySetHash,
  writeManifest,
} from "../../index/manifest.js";
import { resolveDependencies } from "../../resolver/index.js";
import type { QueryContext } from "./context.js";

export interface ResolveNowResult {
  artifactCount: number;
  durationMs: number;
  warnings: string[];
  degraded: Array<{ from: "gradle" | "maven"; reason: string }>;
  /** True when no build system answered and the manifest holds the cache scan's heuristic set. */
  viaCacheScan: boolean;
}

/** Re-resolve and rewrite the v2 manifest unconditionally. */
export async function resolveNow(ctx: QueryContext): Promise<ResolveNowResult> {
  const startedAt = Date.now();
  const resolution = await resolveDependencies(ctx.projectRoot, ctx.resolvers);
  await writeManifest(ctx.projectRoot, {
    version: 2,
    resolvedAt: new Date().toISOString(),
    dependencySetHash: await computeDependencySetHash(ctx.projectRoot, ctx.buildTool, ctx.roots.m2[0].path),
    artifacts: resolution.artifacts,
  });
  return {
    artifactCount: resolution.artifacts.length,
    durationMs: Date.now() - startedAt,
    warnings: [...new Set(resolution.warnings)],
    degraded: resolution.degraded,
    viaCacheScan: resolution.viaCacheScan,
  };
}
