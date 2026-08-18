/**
 * status: the one-call health report — manifest freshness, index size, and
 * whether a JVM is available for decompilation. Nothing here bootstraps or
 * mutates: it reports what is on disk right now, so a fresh project shows
 * `manifest.present: false` until something queries or primes. The JVM probe
 * is the shared per-process `probeJvmOnce`.
 */
import { isStale } from "../../index/manifest.js";
import { probeJvmOnce } from "../../util/jvm.js";
import type { QueryContext } from "./context.js";
import { mergedDegraded } from "./outline.js";

export interface StatusResult {
  projectRoot: string;
  cacheDir: string;
  manifest: {
    present: boolean;
    resolvedAt?: string;
    stale: boolean;
    artifactCount: number;
    dependencySetHash?: string;
  };
  index: {
    artifactCount: number;
    fqnCount: number;
  };
  jvm: {
    available: boolean;
    version?: string;
  };
  degraded: string[];
}

/** Report manifest, index, and JVM state. Never throws on a missing manifest. */
export async function status(ctx: QueryContext): Promise<StatusResult> {
  const manifest = await ctx.manifest();
  const stale = manifest !== null && (await isStale(ctx.projectRoot, manifest));
  const stats = await ctx.store.stats();

  return {
    projectRoot: ctx.projectRoot,
    cacheDir: ctx.cacheDir,
    manifest: {
      present: manifest !== null,
      ...(manifest !== null ? { resolvedAt: manifest.resolvedAt, dependencySetHash: manifest.dependencySetHash } : {}),
      stale,
      artifactCount: manifest?.artifacts.length ?? 0,
    },
    index: { artifactCount: stats.artifactCount, fqnCount: stats.fqnCount },
    jvm: await probeJvmOnce(),
    degraded: await mergedDegraded(ctx, stale ? ["stale index served"] : []),
  };
}
