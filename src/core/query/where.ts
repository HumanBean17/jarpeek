/**
 * where: the on-disk answer to "which paths does this artifact occupy?".
 * Every path the manifest recorded is listed with an existence flag — no
 * unpacking, no entry counting — so an agent or a human can see exactly what
 * is where, and what has vanished since the last resolve. All paths missing
 * is a degraded answer (the manifest no longer describes the disk), not a
 * throw; unknown or ambiguous artifact queries stay fatal.
 */
import { existsSync } from "node:fs";
import type { QueryContext } from "./context.js";
import { mergedDegraded, servedStale } from "./outline.js";
import { resolveArtifactQuery } from "./read-resource.js";

export interface WhereResult {
  coordinates: string;
  paths: Array<{
    role: "binaryJar" | "sourcesJar" | "sourceDir";
    path: string;
    exists: boolean;
  }>;
  /** Present (and true) only when a stale index had to be served. */
  stale?: boolean;
  /** Bootstrap + staleness degradations, same channel as the sibling tools. */
  degraded: string[];
}

const ALL_MISSING = "artifact files missing on disk; run resolve";

/**
 * The artifact's recorded backings as path rows, sources first — the same
 * preference order the provenance ladder uses when it decides what to read.
 * A sourceDirs artifact lists one row per package root, in recorded order.
 */
function recordedPaths(artifact: {
  sourcesJar?: string;
  sourceDirs?: string[];
  binaryJar?: string;
}): WhereResult["paths"] {
  const rows: WhereResult["paths"] = [];
  if (artifact.sourcesJar !== undefined) {
    rows.push({ role: "sourcesJar", path: artifact.sourcesJar, exists: existsSync(artifact.sourcesJar) });
  }
  for (const dir of artifact.sourceDirs ?? []) {
    rows.push({ role: "sourceDir", path: dir, exists: existsSync(dir) });
  }
  if (artifact.binaryJar !== undefined) {
    rows.push({ role: "binaryJar", path: artifact.binaryJar, exists: existsSync(artifact.binaryJar) });
  }
  return rows;
}

/**
 * List an artifact's recorded on-disk paths with an existence flag each.
 * Reads nothing but the manifest and `stat`s nothing but those paths.
 */
export async function where(ctx: QueryContext, coordinates: string): Promise<WhereResult> {
  await ctx.ensureReady();
  const artifact = await resolveArtifactQuery(ctx, coordinates);
  const stale = await servedStale(ctx);
  const paths = recordedPaths(artifact);
  const allMissing = paths.length > 0 && paths.every((row) => !row.exists);

  return {
    coordinates: artifact.coordinates,
    paths,
    ...(stale ? { stale: true as const } : {}),
    degraded: await mergedDegraded(ctx, [
      ...(stale ? ["stale index served"] : []),
      ...(allMissing ? [ALL_MISSING] : []),
    ]),
  };
}
