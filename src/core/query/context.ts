/**
 * Query context: the lazily-bootstrapped entry point every query function
 * hangs off of.
 *
 * Constructing a context resolves and indexes nothing — the first query pays
 * for the bootstrap. `ensureReady` is the only bootstrap trigger: a manifest
 * that exists and is not stale short-circuits; anything else runs
 * resolveDependencies + indexArtifacts under an in-flight memo so concurrent
 * queries bootstrap exactly once.
 *
 * Resolver failures never propagate when there is a manifest to serve — the
 * stale index is served with a `stale` flag and a warning (the degradation
 * ladder). That includes a resolution that degraded all the way to the cache
 * scan: a heuristic artifact set never overwrites a manifest a build tool
 * produced. With no manifest at all there is nothing to serve, and lookups
 * simply miss; a bootstrap that fails in that state is memoized for 60s so
 * repeated queries degrade fast instead of re-running a broken build each
 * time.
 */
import type { DependencyArtifact } from "../types.js";
import { indexArtifacts } from "../../index/indexer.js";
import { isStale, readManifest, type Manifest } from "../../index/manifest.js";
import { IndexStore } from "../../index/store.js";
import { resolveDependencies, type ResolveDependenciesOptions } from "../../resolver/index.js";
import { ensureCacheDir } from "../../util/cache-dir.js";

export interface EnsureReadyResult {
  /** True when this call ran resolve+index (vs serving an existing fresh manifest). */
  bootstrapped: boolean;
  /** True when a stale manifest was served because re-resolution failed. */
  stale: boolean;
}

export interface QueryContext {
  readonly projectRoot: string;
  readonly store: IndexStore;
  /** Cache root shared by the store and the decompile cache. */
  readonly cacheDir: string;
  ensureReady(): Promise<EnsureReadyResult>;
  manifest(): Promise<Manifest | null>;
  artifacts(): Promise<DependencyArtifact[]>;
  /**
   * Warnings of the last bootstrap (cache-scan, stale-served, ...) plus the
   * persisted per-artifact warnings of the manifest being served — a fresh
   * process serving an existing manifest still surfaces what indexing
   * degraded on.
   */
  bootstrapWarnings(): Promise<string[]>;
}

export interface OpenContextOptions {
  resolvers?: ResolveDependenciesOptions;
  cacheDir?: string;
  onProgress?: (msg: string) => void;
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** How long a failed bootstrap suppresses re-resolution. */
const FAILED_BOOTSTRAP_BACKOFF_MS = 60_000;

/** Warning carried when a heuristic cache scan could not replace a real manifest. */
const STALE_SERVED_CACHE_SCAN = "stale index served (resolution degraded to cache scan)";

/**
 * Open a query context. Nothing touches the filesystem beyond cache-dir
 * creation until the first `ensureReady`-bearing query.
 */
export function openContext(projectRoot: string, opts: OpenContextOptions = {}): QueryContext {
  const cacheDir = opts.cacheDir ?? ensureCacheDir();
  const store = new IndexStore(cacheDir);
  const warnings: string[] = [];
  const now = opts.now ?? Date.now;

  /** When a bootstrap failed or served stale (throw, or cache-scan fallback): retries back off to this. */
  let failedAt: number | undefined;

  const addWarning = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  /** Fold the served manifest's persisted per-artifact warnings in (deduped). */
  async function addPersistedArtifactWarnings(): Promise<void> {
    const manifest = await readManifest(projectRoot);
    for (const artifact of manifest?.artifacts ?? []) {
      for (const warning of artifact.warnings ?? []) addWarning(warning);
    }
  }

  async function runBootstrap(wasStale: boolean): Promise<EnsureReadyResult> {
    try {
      const resolution = await resolveDependencies(projectRoot, opts.resolvers);
      // cache-scan is the answer of last resort: when a manifest with indexed
      // artifacts already describes this project, serving it stale (flagged)
      // beats replacing it with a heuristic artifact set that reads as fresh —
      // the degradation ladder's "serve stale index" row
      if (resolution.viaCacheScan) {
        const existing = await readManifest(projectRoot);
        if (existing !== null && existing.artifacts.length > 0) {
          warnings.length = 0;
          for (const entry of resolution.degraded) addWarning(`${entry.from}: ${entry.reason}`);
          addWarning(STALE_SERVED_CACHE_SCAN);
          await addPersistedArtifactWarnings();
          failedAt = now();
          return { bootstrapped: false, stale: true };
        }
      }
      // the channel documents the LAST bootstrap: a successful one starts
      // from a clean slate instead of stacking every historical warning
      warnings.length = 0;
      for (const entry of resolution.degraded) addWarning(`${entry.from}: ${entry.reason}`);
      for (const warning of resolution.warnings) addWarning(warning);
      const result = await indexArtifacts(projectRoot, resolution.artifacts, {
        store,
        onProgress: opts.onProgress,
      });
      for (const warning of result.warnings) addWarning(warning);
      failedAt = undefined;
      return { bootstrapped: true, stale: wasStale };
    } catch (e) {
      const manifest = await readManifest(projectRoot);
      if (manifest !== null) {
        addWarning(`stale index served (resolution failed: ${errorMessage(e)})`);
        await addPersistedArtifactWarnings();
        return { bootstrapped: false, stale: true };
      }
      // nothing to serve and nothing produced: memoize the failure so a
      // retry storm of queries does not become a retry storm of builds
      failedAt = now();
      addWarning(`resolution failed: ${errorMessage(e)}`);
      return { bootstrapped: false, stale: false };
    }
  }

  let inFlight: Promise<EnsureReadyResult> | undefined;

  return {
    projectRoot,
    store,
    cacheDir,
    async ensureReady(): Promise<EnsureReadyResult> {
      const manifest = await readManifest(projectRoot);
      if (manifest !== null && !(await isStale(projectRoot, manifest))) {
        // serving an existing manifest without bootstrapping: its persisted
        // warnings are this process's view of what indexing degraded on
        await addPersistedArtifactWarnings();
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
