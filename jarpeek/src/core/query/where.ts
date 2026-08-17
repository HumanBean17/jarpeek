/**
 * where: the on-disk answer to "which sources am I actually reading?".
 * Sources jars are unpacked once per artifact under the cache dir — a marker
 * file's mtime, written after extraction, decides whether the zip needs
 * opening again — so an agent or a human can open the exact file read_source
 * slices from. Artifacts without sources point at what does exist: the
 * module's source dir, the binary jar itself, or the JDK's install layout.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { listZipEntries, readZipEntry } from "../../parse/zip.js";
import type { QueryContext } from "./context.js";
import { resolveArtifactQuery } from "./read-resource.js";

export interface WhereResult {
  coordinates: string;
  dir: string;
  fileCount: number;
  note?: string;
}

/** Marker written after a complete extraction; its mtime is the freshness clock. */
const UNPACK_MARKER = ".jarpeek-unpacked";

/** Regular files under `dir`, excluding the unpack marker itself. */
function countFiles(dir: string): number {
  let count = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) count += countFiles(join(dir, item.name));
    else if (item.isFile() && item.name !== UNPACK_MARKER) count++;
  }
  return count;
}

/**
 * Unpack `sourcesJar` under `<cacheDir>/v1/unpacked/<safe>/`, reusing a
 * previous extraction whose marker postdates the jar. Entry paths are
 * resolved-and-checked against the target root so a hostile archive cannot
 * write outside it.
 */
async function unpackSources(ctx: QueryContext, jar: string, safeDir: string): Promise<number> {
  const marker = join(safeDir, UNPACK_MARKER);
  const jarMtime = statSync(jar).mtimeMs;
  if (existsSync(marker) && statSync(marker).mtimeMs > jarMtime) {
    return countFiles(safeDir);
  }

  mkdirSync(safeDir, { recursive: true });
  const root = resolve(safeDir);
  let count = 0;
  for (const zipEntry of await listZipEntries(jar)) {
    if (zipEntry.isDirectory) continue;
    const target = resolve(safeDir, zipEntry.name);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`refusing to extract unsafe entry ${zipEntry.name} from ${jar}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await readZipEntry(jar, zipEntry));
    count++;
  }
  // written last: its presence means the extraction finished
  writeFileSync(marker, `${Date.now()}\n`);
  return count;
}

/**
 * Locate an artifact's sources on disk. Sources jars unpack lazily into the
 * cache; everything else reports its existing location with a note when it
 * is not a sources tree.
 */
export async function where(ctx: QueryContext, coordinates: string): Promise<WhereResult> {
  await ctx.ensureReady();
  const artifact = await resolveArtifactQuery(ctx, coordinates);

  if (artifact.sourceDir !== undefined && existsSync(artifact.sourceDir)) {
    return { coordinates: artifact.coordinates, dir: artifact.sourceDir, fileCount: countFiles(artifact.sourceDir) };
  }

  // JDK sources are not unpacked: src.zip is browsable in place and the
  // extracted module tree already is a directory
  if (artifact.kind === "jdk") {
    if (artifact.sourcesJar !== undefined) {
      const entries = (await listZipEntries(artifact.sourcesJar)).filter((e) => !e.isDirectory).length;
      return {
        coordinates: artifact.coordinates,
        dir: dirname(artifact.sourcesJar),
        fileCount: entries,
        note: `jdk src.zip (${artifact.sourcesJar})`,
      };
    }
    if (artifact.classesDir !== undefined) {
      return {
        coordinates: artifact.coordinates,
        dir: dirname(artifact.classesDir),
        fileCount: countFiles(artifact.classesDir),
        note: "jdk jimage-extracted class files (signatures only)",
      };
    }
  }

  if (artifact.sourcesJar !== undefined) {
    const safe = encodeURIComponent(artifact.coordinates);
    const dir = join(ctx.cacheDir, "v1", "unpacked", safe);
    const fileCount = await unpackSources(ctx, artifact.sourcesJar, dir);
    return { coordinates: artifact.coordinates, dir, fileCount };
  }

  if (artifact.binaryJar !== undefined) {
    const entries = (await listZipEntries(artifact.binaryJar)).filter((e) => !e.isDirectory).length;
    return {
      coordinates: artifact.coordinates,
      dir: artifact.binaryJar,
      fileCount: entries,
      note: "no sources jar; binary jar path",
    };
  }

  if (artifact.classesDir !== undefined) {
    return {
      coordinates: artifact.coordinates,
      dir: dirname(artifact.classesDir),
      fileCount: countFiles(artifact.classesDir),
      note: "classes directory (parent of classesDir)",
    };
  }

  throw new Error(`no source location for ${artifact.coordinates}`);
}
