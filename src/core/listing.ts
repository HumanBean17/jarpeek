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
import { isSourceEntry, walkFiles } from "../index/walk.js";
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
  /** Set when no backing exists or it could not be read; classes/entries empty. */
  unreadable?: string;
}

export interface ListingServiceOptions {
  listZip?: typeof listZipEntries;
  stat?: (path: string) => { mtimeMs: number; size: number };
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
  path: string;
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
   * through to a stale sources jar.
   */
  async listing(artifact: DependencyArtifact): Promise<ArtifactListing> {
    const backing = this.pickBacking(artifact);
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
      this.cache.set(artifact.coordinates, { stamp: "", listing: none });
      return none;
    }
    const cached = this.cache.get(artifact.coordinates);
    if (cached && cached.stamp === backing.stamp) return cached.listing;

    const listing =
      backing.source === "sourceDir"
        ? this.listingFromSourceDir(artifact, backing)
        : await this.listingFromZip(artifact, backing);
    this.cache.set(artifact.coordinates, { stamp: backing.stamp, listing });
    return listing;
  }

  /** First existing backing with its stamp; a stat failure means "not there" for selection purposes. */
  private pickBacking(artifact: DependencyArtifact): Backing {
    const candidates: readonly (readonly [ListingSource, string | undefined])[] = [
      ["binary", artifact.binaryJar],
      ["sources", artifact.sourcesJar],
      ["sourceDir", artifact.sourceDir],
    ];
    for (const [source, path] of candidates) {
      if (path === undefined) continue;
      try {
        const { mtimeMs, size } = this.stat(path);
        return { source, path, stamp: `${mtimeMs}:${size}` };
      } catch {
        // unstatable (vanished, unreadable) — try the next backing
      }
    }
    return { source: "binary", path: "", stamp: "" };
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
    const files = walkFiles(backing.path, isSourceEntry, true, warnings);
    const base = { coordinates: artifact.coordinates, source: backing.source, stamp: backing.stamp };
    if (files.length === 0 && warnings.length > 0) {
      return { ...base, classes: [], entries: [], unreadable: warnings[0] };
    }
    return {
      ...base,
      classes: files
        .filter((file) => isIndexableEntryName(file))
        .map((file) => ({ fqn: entryToFqn(file), entry: file })),
      entries: [],
    };
  }
}
