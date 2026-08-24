/**
 * Resolver facade — the single entry point for dependency resolution.
 *
 * The query layer and the `resolve` command call only `resolveDependencies`;
 * they never touch the individual resolvers. The cascade is: for each
 * detected build system in `detectBuildSystems` order (gradle, then maven),
 * the first resolver that returns `ok` with at least one artifact wins and
 * the remaining systems are skipped. When every detected system fails — or
 * none was detected — the local machine caches are scanned instead, and each
 * build-system failure is recorded in `degraded` so callers can surface why
 * the answer is heuristic. The JDK pseudo-artifact is appended last: it is a
 * real dependency of any Java project, just one no build tool reports.
 */
import type { DependencyArtifact } from "../core/types.js";
import { scanCaches } from "./cache-scan.js";
import { detectBuildSystems, type BuildSystem } from "./detect.js";
import { resolveGradle } from "./gradle.js";
import { resolveJdk } from "./jdk.js";
import { resolveMaven } from "./maven.js";
import type { BuildToolStrategy } from "./strategy.js";

export { detectBuildSystems, type BuildSystem } from "./detect.js";

export interface DegradedEntry {
  from: "gradle" | "maven";
  reason: string;
}

export interface ResolutionOutcome {
  artifacts: DependencyArtifact[];
  warnings: string[];
  degraded: DegradedEntry[];
  /**
   * True when no detected build system answered and the artifacts are the
   * cache scan's heuristic set. Callers with a previously-resolved manifest
   * serve that stale (flagged) instead of replacing it with this guesswork.
   */
  viaCacheScan: boolean;
}

/** Resolver functions overridable per-call; defaults are the real ones. */
export interface ResolveDependenciesOptions {
  gradle?: typeof resolveGradle;
  maven?: typeof resolveMaven;
  cacheScan?: typeof scanCaches;
  jdk?: typeof resolveJdk;
  /** Append the JDK pseudo-artifact unless explicitly false. */
  includeJdk?: boolean;
  /**
   * Which mvn/gradle runs the resolvers — system-first with wrapper
   * fallback when unset (`auto`), or a forced direction. See `strategy.ts`.
   */
  strategy?: BuildToolStrategy;
}

const DEGRADED_WARNING = "degraded-to-cache-scan";
/** Reason recorded for a resolution that succeeded but produced nothing. */
const NO_ARTIFACTS = "no-artifacts";

/** Dedup by coordinates, first occurrence (with its sourceDir) wins. */
function dedup(artifacts: DependencyArtifact[]): DependencyArtifact[] {
  const seen = new Set<string>();
  const kept: DependencyArtifact[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.coordinates)) continue;
    seen.add(artifact.coordinates);
    kept.push(artifact);
  }
  return kept;
}

/**
 * Resolve a project's dependency set: gradle → maven → cache-scan cascade,
 * JDK appended, everything deduplicated by coordinates. The `strategy`
 * option is threaded into both resolvers: system-first with wrapper
 * fallback by default (`auto`), or a forced direction. Failures degrade
 * into `degraded` entries and warnings; this function never throws for
 * conditions the resolvers themselves report as `{ ok: false }`.
 */
export async function resolveDependencies(
  projectRoot: string,
  opts: ResolveDependenciesOptions = {},
): Promise<ResolutionOutcome> {
  const gradle = opts.gradle ?? resolveGradle;
  const maven = opts.maven ?? resolveMaven;
  const cacheScan = opts.cacheScan ?? scanCaches;
  const jdk = opts.jdk ?? resolveJdk;

  const warnings: string[] = [];
  const degraded: DegradedEntry[] = [];

  let artifacts: DependencyArtifact[] | null = null;
  let viaCacheScan = false;
  for (const system of detectBuildSystems(projectRoot)) {
    if (system === "gradle") {
      const resolution = await gradle(projectRoot, { strategy: opts.strategy });
      if (resolution.ok && resolution.artifacts.length > 0) {
        artifacts = resolution.artifacts;
        break;
      }
      degraded.push({ from: "gradle", reason: resolution.reason ?? NO_ARTIFACTS });
    } else {
      const resolution = await maven(projectRoot, { strategy: opts.strategy });
      if (resolution.ok && resolution.artifacts.length > 0) {
        artifacts = resolution.artifacts;
        // a reactor that partially failed still answers, but the missing
        // modules' unique dependencies ride the warning channel
        if (resolution.partial !== undefined) {
          degraded.push({ from: "maven", reason: resolution.partial });
        }
        break;
      }
      degraded.push({ from: "maven", reason: resolution.reason ?? NO_ARTIFACTS });
    }
  }

  if (artifacts === null) {
    // no detected system answered (or none detected) — the caches are the
    // whole truth now, and the warning marks that regardless of whether any
    // system was even attempted
    warnings.push(DEGRADED_WARNING);
    viaCacheScan = true;
    const scan = await cacheScan();
    artifacts = scan.artifacts;
    warnings.push(...scan.warnings);
  }

  if (opts.includeJdk !== false) {
    const jdkResult = await jdk();
    warnings.push(...jdkResult.warnings);
    if (jdkResult.artifact !== null) artifacts = [...artifacts, jdkResult.artifact];
  }

  return { artifacts: dedup(artifacts), warnings, degraded, viaCacheScan };
}
