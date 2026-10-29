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
import { withResolveLock } from "../../index/lock.js";
import { resolveDependencies } from "../../resolver/index.js";
import type { QueryContext } from "./context.js";

export interface ResolveNowResult {
  artifactCount: number;
  durationMs: number;
  warnings: string[];
  degraded: Array<{ from: "gradle" | "maven"; reason: string }>;
  /** True when no build system answered and the manifest holds the cache scan's heuristic set. */
  viaCacheScan: boolean;
  /** Multi-build workspaces only: one entry per build, in resolve order. */
  projects?: Array<{ project: string; artifactCount: number; durationMs: number; viaCacheScan: boolean }>;
}

export interface ResolveNowOptions {
  /**
   * Force dependency update checks (`-U` / `--refresh-dependencies`): the
   * one-command healing path for Maven's cached negative lookups (GH#21).
   * The CLI's `resolve -U` flag and the MCP `resolve` tool's `forceUpdate`
   * input land here; the lazy bootstrap never sets it.
   */
  forceUpdate?: boolean;
}

/** Re-resolve and rewrite the v2 manifest unconditionally. */
export async function resolveNow(
  ctx: QueryContext,
  opts: ResolveNowOptions = {},
): Promise<ResolveNowResult> {
  if (ctx.members !== undefined) return resolveEach(ctx, ctx.members, opts);
  const startedAt = Date.now();
  const m2Root = ctx.roots.m2[0].path;
  // serialized with any concurrent resolve of the same build files (another
  // worktree's bootstrap included); unlike the bootstrap, this always runs
  const key = await computeDependencySetHash(ctx.projectRoot, ctx.buildTool, m2Root);
  const resolution = await withResolveLock(key, async () => {
    const outcome = await resolveDependencies(ctx.projectRoot, {
      ...ctx.resolvers,
      ...(opts.forceUpdate ? { forceUpdate: true } : {}),
    });
    await writeManifest(ctx.projectRoot, {
      version: 2,
      resolvedAt: new Date().toISOString(),
      dependencySetHash: await computeDependencySetHash(ctx.projectRoot, ctx.buildTool, m2Root),
      artifacts: outcome.artifacts,
      // same contract as the bootstrap's write: only truncating degradations
      // (the maven partial entry, or every entry of a cache-scan resolution)
      // mark the manifest non-exhaustive
      ...(outcome.incomplete.length > 0 ? { incomplete: outcome.incomplete } : {}),
    });
    return outcome;
  });
  return {
    artifactCount: resolution.artifacts.length,
    durationMs: Date.now() - startedAt,
    warnings: [...new Set(resolution.warnings)],
    degraded: resolution.degraded,
    viaCacheScan: resolution.viaCacheScan,
  };
}

/**
 * A multi-build workspace resolves every build in turn (one build tool run
 * at a time — they share the local repository). Warnings and degraded
 * reasons are labeled with their build; the count is the union's.
 */
async function resolveEach(
  ctx: QueryContext,
  members: NonNullable<QueryContext["members"]>,
  opts: ResolveNowOptions,
): Promise<ResolveNowResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const degraded: ResolveNowResult["degraded"] = [];
  const projects: NonNullable<ResolveNowResult["projects"]> = [];
  for (const { project, ctx: member } of members) {
    const one = await resolveNow(member, opts);
    warnings.push(...one.warnings.map((w) => `${project}: ${w}`));
    degraded.push(...one.degraded.map((d) => ({ ...d, reason: `${project}: ${d.reason}` })));
    projects.push({ project, artifactCount: one.artifactCount, durationMs: one.durationMs, viaCacheScan: one.viaCacheScan });
  }
  return {
    artifactCount: (await ctx.artifacts()).length,
    durationMs: Date.now() - startedAt,
    warnings: [...new Set(warnings)],
    degraded,
    viaCacheScan: projects.some((p) => p.viaCacheScan),
    projects,
  };
}
