/**
 * Query context: the lazily-bootstrapped entry point every query function
 * hangs off of.
 *
 * Constructing a context resolves nothing — the first query pays for the
 * bootstrap. Construction itself touches the filesystem once: strategy
 * convergence reads `.jarpeek/config.json` (absent/corrupt means auto). `ensureReady` is the only bootstrap trigger: a manifest that
 * exists and is not stale short-circuits; anything else runs
 * resolveDependencies and rewrites the manifest (v2: an artifact list, no
 * shards) under an in-flight memo so concurrent queries bootstrap exactly
 * once. Nothing indexes anywhere: queries answer from the manifest through
 * the ListingService.
 *
 * Resolver failures never propagate when there is a manifest to serve — the
 * stale index is served with a `stale` flag and a warning (the degradation
 * ladder). A resolution that degraded all the way to the cache scan is a
 * failure of the same kind: queries never adopt a heuristic artifact set.
 * With a real manifest on disk it is served stale (flagged); with none the
 * bootstrap fails, looksups simply miss, and the failure is memoized for
 * 60s so repeated queries degrade fast instead of re-running a broken build
 * each time. The explicit `resolve` command (resolveNow) keeps the full
 * cascade and will write the flagged heuristic manifest when that is all
 * there is.
 *
 * A context owns a ListingService and a memoized decompiler. It also owns
 * the build-tool strategy convergence (flag > env > config > auto, computed
 * once at open) and keys the manifest fingerprint to the result, so a
 * strategy flip re-resolves rather than serving the other tool's manifest.
 */
import type { DependencyArtifact } from "../types.js";
import {
  computeDependencySetHash,
  isStale,
  readManifest,
  writeManifest,
  type Manifest,
} from "../../index/manifest.js";
import { resolveDependencies, type ResolveDependenciesOptions } from "../../resolver/index.js";
import { effectiveBuildToolStrategy, type BuildToolStrategy } from "../../resolver/strategy.js";
import { effectiveRoots, type EffectiveRoots } from "../../resolver/roots.js";
import { ListingService } from "../listing.js";
import { createDecompiler, type DecompileFn } from "../../decompile/cfr.js";

export interface EnsureReadyResult {
  /** True when this call re-resolved (vs serving an existing fresh manifest). */
  bootstrapped: boolean;
  /** True when a stale manifest was served because re-resolution failed. */
  stale: boolean;
}

export interface QueryContext {
  readonly projectRoot: string;
  /** Resolver options this context was opened with, strategy included (resolveNow reuses them). */
  readonly resolvers: ResolveDependenciesOptions;
  /** The effective build-tool strategy this context resolves and hashes under. */
  readonly buildTool: BuildToolStrategy;
  /**
   * The effective cache roots this context resolves and hashes under, with
   * the layer each came from — what `status` reports and what the manifest
   * fingerprint's `m2Root` line carries.
   */
  readonly roots: EffectiveRoots;
  /** Listing service: provides artifact listings. */
  readonly listings: ListingService;
  /** Memoized decompiler function. */
  readonly decompiler: DecompileFn;
  ensureReady(): Promise<EnsureReadyResult>;
  manifest(): Promise<Manifest | null>;
  artifacts(): Promise<DependencyArtifact[]>;
  /**
   * Warnings of the last bootstrap (cache-scan, stale-served, ...): the
   * channel documents what the process currently serving answers degraded
   * on, not the accumulation of every bootstrap it ever ran.
   */
  bootstrapWarnings(): Promise<string[]>;
}

export interface OpenContextOptions {
  resolvers?: ResolveDependenciesOptions;
  /**
   * The CLI `--build-tool` flag value, unconstrained — invalid values fall
   * through inside convergence (commander validates at the surface).
   */
  buildToolFlag?: string;
  /**
   * One line per bootstrap attempt, emitted right before resolution runs —
   * the only progress a resolve-only bootstrap has to report.
   */
  onNotice?: (msg: string) => void;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How long a failed bootstrap suppresses re-resolution. */
const FAILED_BOOTSTRAP_BACKOFF_MS = 60_000;

/** Notice emitted before the first resolution a project has ever seen. */
const NOTICE_FIRST_RUN = "resolving dependencies (first run — may download dependencies and sources)";
/** Notice emitted when the manifest exists but no longer matches the build. */
const NOTICE_STALE = "resolving dependencies (manifest stale)";
/** While a bootstrap runs, one heartbeat per this many milliseconds. */
const HEARTBEAT_MS = 30_000;

/** Warning carried when a heuristic cache scan could not replace a real manifest. */
const STALE_SERVED_CACHE_SCAN = "stale index served (resolution degraded to cache scan)";
/** Warning carried when a heuristic cache scan was all resolution produced, with no manifest to serve. */
const FAILED_CACHE_SCAN = "resolution failed: degraded to cache-scan; run jarpeek resolve";

/**
 * Open a query context. Nothing touches the filesystem until the first
 * `ensureReady`-bearing query.
 */
export function openContext(projectRoot: string, opts: OpenContextOptions = {}): QueryContext {
  const warnings: string[] = [];
  const now = opts.now ?? Date.now;
  // convergence lives here — one call site for every entry point (CLI flag,
  // env, config); an explicitly injected resolvers.strategy wins over it
  const buildTool: BuildToolStrategy =
    opts.resolvers?.strategy ?? effectiveBuildToolStrategy(projectRoot, opts.buildToolFlag);
  // the same single-call-site rule for the cache roots: computed once,
  // threaded into the resolvers, fingerprinted into the manifest. Unlike
  // strategy above, an injected resolvers.roots does NOT win — the computed
  // convergence is the identity this context hashes under, always
  const roots = effectiveRoots(projectRoot);
  const resolvers: ResolveDependenciesOptions = {
    ...opts.resolvers,
    strategy: buildTool,
    roots: { m2: roots.m2.map((candidate) => candidate.path), gradle: roots.gradle.path },
  };

  /** When a bootstrap failed or served stale (throw, or cache-scan fallback): retries back off to this. */
  let failedAt: number | undefined;

  const addWarning = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  async function runBootstrap(wasStale: boolean): Promise<EnsureReadyResult> {
    // the one progress line a resolve-only bootstrap owes the user…
    opts.onNotice?.(wasStale ? NOTICE_STALE : NOTICE_FIRST_RUN);
    // …plus a heartbeat while it runs: a cold-cache resolve can download for
    // minutes in total silence, which reads exactly like a hang
    const startedAt = now();
    const heartbeat = setInterval(() => {
      opts.onNotice?.(`still resolving (${Math.round((now() - startedAt) / 1000)}s)`);
    }, HEARTBEAT_MS);
    try {
      const resolution = await resolveDependencies(projectRoot, resolvers);
      // cache-scan is the answer of last resort, and queries never adopt its
      // results: with a real manifest already describing this project, serve
      // that stale (flagged) rather than replacing it with a heuristic
      // artifact set that reads as fresh — the degradation ladder's "serve
      // stale index" row
      if (resolution.viaCacheScan) {
        const existing = await readManifest(projectRoot);
        if (existing !== null && existing.artifacts.length > 0) {
          warnings.length = 0;
          for (const entry of resolution.degraded) addWarning(`${entry.from}: ${entry.reason}`);
          addWarning(STALE_SERVED_CACHE_SCAN);
          failedAt = now();
          return { bootstrapped: false, stale: true };
        }
        // no manifest to serve and nothing trustworthy produced: fail the
        // bootstrap (the query answers as a miss) and back off
        warnings.length = 0;
        for (const entry of resolution.degraded) addWarning(`${entry.from}: ${entry.reason}`);
        addWarning(FAILED_CACHE_SCAN);
        failedAt = now();
        return { bootstrapped: false, stale: false };
      }
      // the channel documents the LAST bootstrap: a successful one starts
      // from a clean slate instead of stacking every historical warning
      warnings.length = 0;
      for (const entry of resolution.degraded) addWarning(`${entry.from}: ${entry.reason}`);
      for (const warning of resolution.warnings) addWarning(warning);
      await writeManifest(projectRoot, {
        version: 2,
        resolvedAt: new Date().toISOString(),
        dependencySetHash: await computeDependencySetHash(projectRoot, buildTool, roots.m2[0].path),
        artifacts: resolution.artifacts,
      });
      failedAt = undefined;
      return { bootstrapped: true, stale: wasStale };
    } catch (e) {
      const manifest = await readManifest(projectRoot);
      if (manifest !== null) {
        addWarning(`stale index served (resolution failed: ${errorMessage(e)})`);
        return { bootstrapped: false, stale: true };
      }
      // nothing to serve and nothing produced: memoize the failure so a
      // retry storm of queries does not become a retry storm of builds
      failedAt = now();
      addWarning(`resolution failed: ${errorMessage(e)}`);
      return { bootstrapped: false, stale: false };
    } finally {
      clearInterval(heartbeat);
    }
  }

  let inFlight: Promise<EnsureReadyResult> | undefined;

  // Construct once per context
  const listings = new ListingService();
  const decompiler = createDecompiler();

  return {
    projectRoot,
    resolvers,
    buildTool,
    roots,
    listings,
    decompiler,
    async ensureReady(): Promise<EnsureReadyResult> {
      const manifest = await readManifest(projectRoot);
      if (manifest !== null && !(await isStale(projectRoot, manifest, buildTool, roots.m2[0].path))) {
        return { bootstrapped: false, stale: false };
      }
      if (failedAt !== undefined && now() - failedAt < FAILED_BOOTSTRAP_BACKOFF_MS) {
        if (manifest === null) {
          addWarning("resolution failed recently; retrying later");
          return { bootstrapped: false, stale: false };
        }
        // resolution keeps failing or degrading while a manifest exists:
        // serve it stale rather than re-running a broken build per query
        addWarning("stale index served (resolution failed recently)");
        return { bootstrapped: false, stale: true };
      }
      if (!inFlight) {
        inFlight = runBootstrap(manifest !== null).finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },
    manifest: () => readManifest(projectRoot),
    async artifacts(): Promise<DependencyArtifact[]> {
      const manifest = await readManifest(projectRoot);
      return manifest === null ? [] : manifest.artifacts;
    },
    bootstrapWarnings: async () => [...warnings],
  };
}
