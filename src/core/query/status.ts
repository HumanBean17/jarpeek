/**
 * status: the one-call health report — manifest freshness and whether a JVM
 * is available for decompilation. Nothing here bootstraps or mutates, and
 * nothing reads the index: it reports what is on disk right now, so a fresh
 * project shows `manifest.present: false` until something queries or primes.
 * The JVM probe defaults to the shared per-process `probeJvmOnce`; tests
 * inject their own through the `opts.jvm` seam so they do not depend on the
 * host machine.
 */
import { manifestPath } from "../../index/manifest.js";
import { probeJvmOnce, type JvmProbe } from "../../util/jvm.js";
import type { RootCandidate } from "../../resolver/roots.js";
import type { QueryContext } from "./context.js";
import { mergedDegraded } from "./outline.js";

export interface StatusResult {
  projectRoot: string;
  manifest: {
    present: boolean;
    /** The shared cache file serving this project (absent when no manifest exists yet). */
    path?: string;
    resolvedAt?: string;
    stale: boolean;
    /** True when the manifest records a partial resolution — a negative over it is not definitive (GH#18). */
    incomplete: boolean;
    artifactCount: number;
    dependencySetHash?: string;
  };
  /** Effective cache roots with the layer each came from — a GH#12-class misconfiguration is a one-command diagnosis. */
  resolver: {
    m2Root: RootCandidate;
    gradleCacheRoot: RootCandidate;
  };
  jvm: {
    available: boolean;
    version?: string;
  };
  degraded: string[];
  /**
   * Multi-build workspaces only: each build's own manifest report, labeled
   * by its workspace-relative path. The top-level `manifest` summarizes the
   * union (stale/incomplete when any build is).
   */
  projects?: Array<{
    project: string;
    projectRoot: string;
    manifest: StatusResult["manifest"];
    degraded: string[];
  }>;
}

/** Test injection point for the JVM probe; defaults to the shared memoized one. */
export interface StatusOptions {
  jvm?: () => Promise<JvmProbe>;
}

/** Report manifest and JVM state. Never throws on a missing manifest. */
export async function status(ctx: QueryContext, opts: StatusOptions = {}): Promise<StatusResult> {
  const manifest = await ctx.manifest();
  const stale = await ctx.stale();

  return {
    projectRoot: ctx.projectRoot,
    manifest: {
      present: manifest !== null,
      // a merged (multi-build) manifest is a union, not a cache file: no path
      ...(manifest !== null && ctx.members === undefined
        ? {
            path: manifestPath(manifest.dependencySetHash),
            resolvedAt: manifest.resolvedAt,
            dependencySetHash: manifest.dependencySetHash,
          }
        : manifest !== null
          ? { resolvedAt: manifest.resolvedAt, dependencySetHash: manifest.dependencySetHash }
          : {}),
      stale,
      incomplete: (manifest?.incomplete?.length ?? 0) > 0,
      artifactCount: manifest?.artifacts.length ?? 0,
    },
    jvm: await (opts.jvm ?? probeJvmOnce)(),
    resolver: { m2Root: ctx.roots.m2[0], gradleCacheRoot: ctx.roots.gradle },
    degraded: await mergedDegraded(ctx, stale ? ["stale index served"] : []),
    ...(ctx.members !== undefined
      ? {
          projects: await Promise.all(
            ctx.members.map(async ({ project, ctx: member }) => {
              const own = await status(member, opts);
              return { project, projectRoot: member.projectRoot, manifest: own.manifest, degraded: own.degraded };
            }),
          ),
        }
      : {}),
  };
}
