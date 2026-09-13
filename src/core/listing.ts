/**
 * In-process artifact→entry-name listings: the lazy replacement for the
 * eager declaration index. Every query starts from a ListingService result —
 * which backing (binary jar, sources jar, source dir) an artifact has, the
 * raw zip entries, and the class-entry names derivable from them — and only
 * then reads entry bytes on demand. Listings are cached per coordinates and
 * keyed by a file stamp, so a rebuild or re-resolved jar is re-listed while
 * an untouched one costs one stat. This module never writes to disk.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { isSourceEntry, walkFiles } from "../util/walk.js";
import { isClassEntry } from "../parse/records.js";
import { listZipEntries, type ZipEntry } from "../parse/zip.js";
import type { DependencyArtifact } from "./types.js";

/** One indexable class location: fqn plus the entry/relpath it came from. */
export interface ClassEntry {
  fqn: string;
  entry: string;
}
/** Which backing a listing was derived from. */
export type ListingSource = "binary" | "sources" | "sourceDir";

export interface ArtifactListing {
  coordinates: string;
  source: ListingSource;
  classes: ClassEntry[];
  /** Raw central-directory listing for jar backings; empty for sourceDir. */
  entries: readonly ZipEntry[];
  /** `${mtimeMs}:${size}` of the backing; identifies the listed version. */
  stamp: string;
  /** sourceDir backings only: relpath → the package root that produced it (first root wins). */
  entryRoots?: ReadonlyMap<string, string>;
  /** Set when no backing exists or it could not be read; classes/entries empty. */
  unreadable?: string;
}

/**
 * Absolute path of one sourceDir-listed entry, or undefined when the listing
 * does not carry it. Every sourceDir read goes through here — the listing is
 * the only party that knows which package root produced which relpath.
 */
export function sourceEntryPath(listing: ArtifactListing, entry: string): string | undefined {
  const root = listing.entryRoots?.get(entry);
  return root === undefined ? undefined : join(root, entry);
}

export interface ListingServiceOptions {
  listZip?: typeof listZipEntries;
  stat?: (path: string) => { mtimeMs: number; size: number };
}

export interface ListingOptions {
  /**
   * List this backing instead of the preferred one — locate's winner parse
   * asks for `sources`/`sourceDir` explicitly (the spec's provenance ladder
   * serves source text when a sources backing has the file). Default keeps
   * the binary → sources → sourceDir preference.
   */
  backing?: ListingSource;
}

/**
 * Anonymous and local classes compile to digit simple names (`Outer$1`),
 * and synthetic lambda shapes surface the same way. None are navigation
 * targets, so an entry is dropped when its innermost identifier segment —
 * the simple name after the last `/`, extension stripped, then the segment
 * after the last `$` — does not start a Java identifier. This works on RAW
 * entry names, unlike `isIndexableClass` (dotted parsed fqns, where the
 * class-file reader already mapped `$` to `.`), so `Outer$1` is rejected
 * here without parsing anything.
 */
export const isIndexableEntryName = (entryName: string): boolean => {
  const simple = entryName.slice(entryName.lastIndexOf("/") + 1);
  const dot = simple.lastIndexOf(".");
  const stem = dot === -1 ? simple : simple.slice(0, dot);
  const dollar = stem.lastIndexOf("$");
  const ident = dollar === -1 ? stem : stem.slice(dollar + 1);
  return /^[A-Za-z_]/.test(ident);
};

/** `a/b/Outer$Inner.class` → `a.b.Outer$Inner`; source extensions likewise drop. */
const entryToFqn = (entry: string): string => {
  const stem = entry.slice(0, entry.lastIndexOf("."));
  return stem.split("/").join(".");
};

/** Entries worth navigating to, per the backing's keep predicate plus the ident filter. */
function classEntriesFrom(
  entries: readonly ZipEntry[],
  keep: (name: string) => boolean,
): ClassEntry[] {
  return entries
    .filter((e) => keep(e.name) && isIndexableEntryName(e.name))
    .map((e) => ({ fqn: entryToFqn(e.name), entry: e.name }));
}

interface Backing {
  source: ListingSource;
  /** Jar path for zip backings; the first statable root for sourceDirs. */
  path: string;
  /** sourceDirs backings: every statable package root, in artifact order. */
  paths: string[];
  stamp: string;
}

const NO_BACKING_UNREADABLE = "no jar or source dir";

/**
 * Listings by coordinates, each pinned to the stamp it was built from. A
 * stamp change (rebuilt jar, edited source dir) re-lists; an unreadable
 * cached result is retried the same way, so a fixed jar recovers on the
 * next query without a service restart.
 */
export class ListingService {
  private readonly listZip: typeof listZipEntries;
  private readonly stat: (path: string) => { mtimeMs: number; size: number };
  private readonly cache = new Map<string, { stamp: string; listing: ArtifactListing }>();

  constructor(opts: ListingServiceOptions = {}) {
    this.listZip = opts.listZip ?? listZipEntries;
    this.stat = opts.stat ?? statSync;
  }

  /** Drop the cached listing for one artifact (used by tests and manual refresh). */
  invalidate(coordinates: string): void {
    this.cache.delete(coordinates);
  }

  /**
   * List an artifact's backing, in preference order binaryJar → sourcesJar →
   * sourceDir. The first backing that stats wins even if it later fails to
   * read: a corrupt binary jar must surface as unreadable, not silently fall
   * through to a stale sources jar. `opts.backing` pins one backing instead
   * (an explicitly requested missing/unreadable backing answers unreadable).
   */
  async listing(artifact: DependencyArtifact, opts: ListingOptions = {}): Promise<ArtifactListing> {
    const backing = this.pickBacking(artifact, opts.backing);
    // the default lane keeps its historical cache key (plain coordinates) so
    // its identity is untouched; explicit backings cache under coord:backing
    const key = opts.backing === undefined ? artifact.coordinates : `${artifact.coordinates}:${opts.backing}`;
    if (backing.stamp === "") {
      // no candidate backing stated: the discriminator is meaningless, keep "binary"
      const none: ArtifactListing = {
        coordinates: artifact.coordinates,
        source: "binary",
        classes: [],
        entries: [],
        stamp: "",
        unreadable: NO_BACKING_UNREADABLE,
      };
      this.cache.set(key, { stamp: "", listing: none });
      return none;
    }
    // sourceDir listings are re-walked on every call, never served from the
    // stamp cache: these are the trees an agent edits mid-session, and a
    // cached listing would miss a class added seconds ago (reads stay fresh
    // through sourceEntryPath; only the listing could go stale). Directory
    // walks are the cheap part — jar listings, which parse central
    // directories, keep the cache. The stamp below is derived from the walk
    // itself, so an unchanged tree keeps a stable stamp and the parse memo
    // keyed on it survives.
    if (backing.source === "sourceDir") {
      const listing = this.listingFromSourceDir(artifact, backing);
      this.cache.set(key, { stamp: listing.stamp, listing });
      return listing;
    }
    const cached = this.cache.get(key);
    if (cached && cached.stamp === backing.stamp) return cached.listing;

    const listing = await this.listingFromZip(artifact, backing);
    this.cache.set(key, { stamp: backing.stamp, listing });
    return listing;
  }

  /**
   * First existing backing with its stamp; a stat failure means "not there"
   * for selection purposes. A `pin` skips the preference walk and goes
   * straight to that backing's path. The sourceDirs lane stamps over every
   * root that stats (artifact order): a root appearing, vanishing, or moving
   * re-lists, while a declared-but-absent root — a test tree a module simply
   * does not have — contributes nothing instead of failing the whole backing.
   * An artifact whose roots all fail to stat has no sourceDirs backing.
   */
  private pickBacking(artifact: DependencyArtifact, pin?: ListingSource): Backing {
    if (pin === undefined || pin === "binary" || pin === "sources") {
      const jars: readonly (readonly [ListingSource, string | undefined])[] =
        pin === undefined
          ? [
              ["binary", artifact.binaryJar],
              ["sources", artifact.sourcesJar],
            ]
          : [pin === "binary" ? ["binary", artifact.binaryJar] : ["sources", artifact.sourcesJar]];
      for (const [source, path] of jars) {
        if (path === undefined) continue;
        try {
          const { mtimeMs, size } = this.stat(path);
          return { source, path, paths: [path], stamp: `${mtimeMs}:${size}` };
        } catch {
          // unstatable (vanished, unreadable) — try the next backing
        }
      }
      if (pin !== undefined) return { source: pin, path: "", paths: [], stamp: "" };
    }
    if ((pin === undefined || pin === "sourceDir") && artifact.sourceDirs !== undefined) {
      const stamps: string[] = [];
      const paths: string[] = [];
      for (const root of artifact.sourceDirs) {
        try {
          const { mtimeMs, size } = this.stat(root);
          stamps.push(`${mtimeMs}:${size}`);
          paths.push(root);
        } catch {
          // unstatable root: contributes nothing, the surviving roots answer
        }
      }
      if (paths.length > 0) {
        return { source: "sourceDir", path: paths[0]!, paths, stamp: stamps.join("|") };
      }
      if (pin === "sourceDir") return { source: "sourceDir", path: "", paths: [], stamp: "" };
    }
    return { source: "binary", path: "", paths: [], stamp: "" };
  }

  private async listingFromZip(
    artifact: DependencyArtifact,
    backing: Backing,
  ): Promise<ArtifactListing> {
    const base = { coordinates: artifact.coordinates, source: backing.source, stamp: backing.stamp };
    let entries: readonly ZipEntry[];
    try {
      entries = await this.listZip(backing.path);
    } catch (e) {
      // unreadable is a result, not an exception: callers aggregate it as a
      // degraded note and keep querying the other artifacts
      const unreadable = `failed to list ${backing.path}: ${(e as Error).message}`;
      return { ...base, classes: [], entries: [], unreadable };
    }
    const keep = backing.source === "binary" ? isClassEntry : isSourceEntry;
    return { ...base, classes: classEntriesFrom(entries, keep), entries };
  }

  private listingFromSourceDir(artifact: DependencyArtifact, backing: Backing): ArtifactListing {
    // walk warnings have no channel on ArtifactListing; a walk that read
    // nothing while warning means the dir itself was unreadable
    const warnings: string[] = [];
    const entryRoots = new Map<string, string>();
    for (const root of backing.paths) {
      for (const file of walkFiles(root, isSourceEntry, true, warnings)) {
        // first root wins: overlapping sourceSets (generated sources beside
        // handwritten ones) list the class once, from the root that owns it
        if (!entryRoots.has(file)) entryRoots.set(file, root);
      }
    }
    const base = { coordinates: artifact.coordinates, source: backing.source };
    if (entryRoots.size === 0 && warnings.length > 0) {
      return { ...base, stamp: backing.stamp, classes: [], entries: [], unreadable: warnings[0] };
    }
    const files = [...entryRoots.keys()].sort();
    // content-derived stamp: every listed file's stat, in sorted relpath
    // order — any add, edit, or delete inside the tree re-keys the listing
    // and the parse memo above it, while an unchanged tree is stable. A
    // vanished file stats as (gone) rather than throwing.
    const stamp = files
      .map((file) => {
        try {
          const { mtimeMs, size } = this.stat(join(entryRoots.get(file)!, file));
          return `${mtimeMs}:${size}`;
        } catch {
          return "(gone)";
        }
      })
      .join("|");
    return {
      ...base,
      stamp,
      classes: files
        .filter((file) => isIndexableEntryName(file))
        .map((file) => ({ fqn: entryToFqn(file), entry: file })),
      entries: [],
      entryRoots,
    };
  }
}
