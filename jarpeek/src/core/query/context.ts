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
 * ladder). With no manifest at all there is nothing to serve, and lookups
 * simply miss; a bootstrap that throws in that state is memoized for 60s so
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
  /** Warnings accumulated by the last bootstrap (cache-scan, stale-served, ...). */
  bootstrapWarnings(): string[];
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

/** How long a failed no-manifest bootstrap suppresses re-resolution. */
const FAILED_BOOTSTRAP_BACKOFF_MS = 60_000;

/**
 * Open a query context. Nothing touches the filesystem beyond cache-dir
 * creation until the first `ensureReady`-bearing query.
 */
export function openContext(projectRoot: string, opts: OpenContextOptions = {}): QueryContext {
  const cacheDir = opts.cacheDir ?? ensureCacheDir();
  const store = new IndexStore(cacheDir);
  const warnings: string[] = [];
  const now = opts.now ?? Date.now;

  /** When a bootstrap threw with no manifest to serve: retries back off to this. */
  let failedAt: number | undefined;

  const addWarning = (msg: string): void => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  async function runBootstrap(wasStale: boolean): Promise<EnsureReadyResult> {
    try {
      const resolution = await resolveDependencies(projectRoot, opts.resolvers);
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
        return { bootstrapped: false, stale: false };
      }
      if (manifest === null && failedAt !== undefined && now() - failedAt < FAILED_BOOTSTRAP_BACKOFF_MS) {
        addWarning("resolution failed recently; retrying later");
        return { bootstrapped: false, stale: false };
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
    bootstrapWarnings: () => [...warnings],
  };
}
