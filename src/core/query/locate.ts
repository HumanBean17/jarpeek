/**
 * Locate: listings-backed FQN → artifact location and one-file record
 * parsing — the store's replacement. The manifest's artifacts are listed in
 * order (ListingService caches per coordinates+stamp) and the first whose
 * backing declares the fqn is parsed from exactly one file: its source entry
 * or its compiled class entry, plus one class row per directly nested class
 * entry. Later hits become `alternatives`; unreadable artifacts and entries
 * that failed to read or parse become aggregated `degraded` notes — the only
 * throw is the LookupMissError protocol. `recordsForArtifact` (Task 9) will
 * reuse this listing+parse plumbing to feed the search layer a whole
 * artifact at a time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactListing, ListingService } from "../listing.js";
import type { Declaration, DependencyArtifact, Provenance } from "../types.js";
import type { Manifest } from "../../index/manifest.js";
import { recordsFromClassBytes, recordsFromSourceText } from "../../parse/records.js";
import { readTextEntry, readZipEntry, type ZipEntry } from "../../parse/zip.js";
import { isClassKind, LookupMissError } from "./outline.js";

/** What locateClass needs from its host; QueryContext satisfies this structurally. */
export interface LocateDeps {
  listings: ListingService;
  manifest(): Promise<Manifest | null>;
}

export interface LocateOptions {
  /** Include one class-kind row per directly nested class (default true). */
  includeNested?: boolean;
}

export interface LocatedClass {
  artifact: DependencyArtifact;
  /** Jar entry name or sourceDir relpath the records were parsed from. */
  entry: string;
  /** The class's own row, its member rows, and (includeNested) nested class rows. */
  records: Declaration[];
  /** "source" for sources/sourceDir backings; "signature" for binary — locate never decompiles. */
  provenance: Provenance;
}

export interface LocateResult {
  winner: LocatedClass;
  alternatives: Array<{ coordinates: string }>;
  degraded: string[];
}

/**
 * True when `recordFqn` is `target` itself or a direct-or-deeper nested
 * member via either separator: nested classes surface as `target + "." +
 * rest` from source parsing and class-file parsing alike (the reader maps
 * `$` to `.`), while listing fqns keep the `$`. Dot- and dollar-nesting
 * therefore match each other; `OuterX` is never a member of `Outer`.
 */
export const classFamily = (recordFqn: string, target: string): boolean =>
  recordFqn === target ||
  (recordFqn.startsWith(`${target}.`) && recordFqn.length > target.length + 1) ||
  (recordFqn.startsWith(`${target}$`) && recordFqn.length > target.length + 1);

/** Source extensions in preference order for source-backed lookups. */
const SOURCE_EXTS = [".java", ".kt"] as const;

/** `a.b.Outer` → `a/b/Outer`, the jar-entry form of an fqn. */
const internalName = (fqn: string): string => fqn.replaceAll(".", "/");

/**
 * The zip entry backing the DOTTED `fqn` in a jar listing, or null when the
 * artifact does not declare it. The query layer speaks dotted fqns
 * (`a.b.Outer.Inner`); listing fqns keep the `$`, so a binary hit is the
 * entry whose name maps `$`→`.` onto the query. Source hits try `.java`
 * then `.kt` exactly, else a UNIQUE `"/" + candidate` suffix (relocated
 * source roots) — two or more suffix matches are ambiguous and count as a
 * miss rather than a coin flip.
 */
function findZipHit(listing: ArtifactListing, fqn: string): ZipEntry | null {
  if (listing.source === "binary") {
    // a ClassEntry names the entry; the real ZipEntry (offsets, sizes) is
    // found by that name — readZipEntry needs the whole record, not a name
    const dotted = fqn.replaceAll("$", ".");
    const entryName = listing.classes.find((c) => c.fqn.replaceAll("$", ".") === dotted)?.entry;
    return entryName === undefined ? null : (listing.entries.find((e) => e.name === entryName) ?? null);
  }
  for (const ext of SOURCE_EXTS) {
    const candidate = `${internalName(fqn)}${ext}`;
    const exact = listing.entries.find((e) => e.name === candidate);
    if (exact) return exact;
    const suffixed = listing.entries.filter((e) => e.name.endsWith(`/${candidate}`));
    if (suffixed.length === 1) return suffixed[0]!;
    if (suffixed.length > 1) return null;
  }
  return null;
}

/** The relpath of `fqn` in a sourceDir listing (exact entry name only), or null. */
function findSourceDirHit(listing: ArtifactListing, fqn: string): string | null {
  for (const ext of SOURCE_EXTS) {
    const candidate = `${internalName(fqn)}${ext}`;
    if (listing.classes.some((c) => c.entry === candidate)) return candidate;
  }
  return null;
}

/** Scan-wide degradation counters: entries whose read threw or whose parse warned. */
interface Scan {
  failed: number;
}

/**
 * Family filter over source-parsed records: the class's own row and its
 * members carry `fqn` and pass as equal; nested classes (the lexers nest by
 * dots) pass only as class-kind rows — their members belong to the nested
 * class's own lookup, not this one.
 */
function familyRecords(
  records: Declaration[],
  fqn: string,
  includeNested: boolean,
): Declaration[] {
  return records.filter(
    (record) =>
      record.fqn === fqn ||
      (includeNested && isClassKind(record.kind) && classFamily(record.fqn, fqn)),
  );
}

/**
 * Parse the winning source text (sources-jar entry or sourceDir file). A
 * read or lex failure degrades to zero records instead of throwing — the
 * hit still answers which artifact and entry declare the class.
 */
async function sourceLocated(
  artifact: DependencyArtifact,
  entry: string,
  readText: () => Promise<string>,
  fqn: string,
  includeNested: boolean,
  scan: Scan,
): Promise<LocatedClass> {
  let text: string;
  try {
    text = await readText();
  } catch {
    scan.failed++;
    return { artifact, entry, records: [], provenance: "source" };
  }
  const { records, diagnostics } = recordsFromSourceText(text, entry);
  if (diagnostics.length > 0) scan.failed++;
  return { artifact, entry, records: familyRecords(records, fqn, includeNested), provenance: "source" };
}

/**
 * Parse the winning class entry (equal-fqn records: its class row and
 * members — the class-file reader renders fqns dot-separated) plus, when
 * included, one class row per DIRECTLY nested entry: `internal + "$" +
 * ident` where ident has no further `$` and starts a Java identifier, so
 * anonymous/local classes (`Outer$1`) and deeper nesting stay out.
 */
async function binaryLocated(
  artifact: DependencyArtifact,
  listing: ArtifactListing,
  entry: ZipEntry,
  fqn: string,
  includeNested: boolean,
  scan: Scan,
): Promise<LocatedClass> {
  const jar = artifact.binaryJar!;
  const records: Declaration[] = [];
  try {
    const parsed = recordsFromClassBytes(await readZipEntry(jar, entry), entry.name, entry.name);
    if (parsed.warning !== undefined) scan.failed++;
    records.push(...parsed.records.filter((record) => record.fqn === fqn));
  } catch {
    scan.failed++;
  }
  if (includeNested) {
    const prefix = `${internalName(fqn)}$`;
    for (const nested of listing.entries) {
      if (!nested.name.endsWith(".class") || !nested.name.startsWith(prefix)) continue;
      const ident = nested.name.slice(prefix.length, nested.name.length - ".class".length);
      if (ident.includes("$") || !/^[A-Za-z_]/.test(ident)) continue;
      try {
        const parsed = recordsFromClassBytes(await readZipEntry(jar, nested), nested.name, nested.name);
        if (parsed.warning !== undefined) scan.failed++;
        records.push(
          ...parsed.records.filter(
            (record) => isClassKind(record.kind) && classFamily(record.fqn, fqn),
          ),
        );
      } catch {
        scan.failed++;
      }
    }
  }
  return { artifact, entry: entry.name, records, provenance: "signature" };
}

/** Locate `fqn` in one listed artifact, or null when the listing does not declare it. */
async function locateInListing(
  artifact: DependencyArtifact,
  listing: ArtifactListing,
  fqn: string,
  includeNested: boolean,
  scan: Scan,
): Promise<LocatedClass | null> {
  if (listing.source === "sourceDir") {
    const relpath = findSourceDirHit(listing, fqn);
    if (relpath === null) return null;
    const root = artifact.sourceDir!;
    return sourceLocated(
      artifact,
      relpath,
      // readFileSync throws sync on a vanished file; the async wrapper keeps
      // sourceLocated's single try/catch honest for both backings
      async () => readFileSync(join(root, relpath), "utf8"),
      fqn,
      includeNested,
      scan,
    );
  }
  const hit = findZipHit(listing, fqn);
  if (hit === null) return null;
  return listing.source === "binary"
    ? binaryLocated(artifact, listing, hit, fqn, includeNested, scan)
    : sourceLocated(
        artifact,
        hit.name,
        () => readTextEntry(artifact.sourcesJar!, hit),
        fqn,
        includeNested,
        scan,
      );
}

/**
 * Locate `fqn` across the manifest's artifacts in order. Every artifact is
 * listed (hits after the first become the `alternatives` coordinates, never
 * a second parse); an unreadable backing degrades instead of aborting the
 * scan; no hit anywhere throws LookupMissError.
 */
export async function locateClass(
  deps: LocateDeps,
  fqn: string,
  opts: LocateOptions = {},
): Promise<LocateResult> {
  const includeNested = opts.includeNested ?? true;
  // canonical query-layer form: dotted. A `$`-spelled query (`a.b.Outer$Inner`)
  // means the same class as its dotted spelling; all matching below is dotted.
  fqn = fqn.replaceAll("$", ".");
  const artifacts = (await deps.manifest())?.artifacts ?? [];
  const unreadable: string[] = [];
  const scan: Scan = { failed: 0 };
  let winner: LocatedClass | null = null;
  const alternatives: Array<{ coordinates: string }> = [];
  for (const artifact of artifacts) {
    const listing = await deps.listings.listing(artifact);
    if (listing.unreadable !== undefined) {
      unreadable.push(artifact.coordinates);
      continue;
    }
    if (winner === null) {
      winner = await locateInListing(artifact, listing, fqn, includeNested, scan);
    } else if (declaresFqn(listing, fqn)) {
      alternatives.push({ coordinates: artifact.coordinates });
    }
  }
  if (winner === null) throw new LookupMissError(fqn);
  const degraded: string[] = [];
  if (unreadable.length > 0) {
    degraded.push(`${unreadable.length} artifacts unreadable (${unreadable.slice(0, 3).join(", ")})`);
  }
  if (scan.failed > 0) degraded.push(`${scan.failed} entries failed to parse`);
  return { winner, alternatives, degraded };
}

/** Hit test only — after a winner exists, later artifacts contribute coordinates, not bytes. */
function declaresFqn(listing: ArtifactListing, fqn: string): boolean {
  return listing.source === "sourceDir"
    ? findSourceDirHit(listing, fqn) !== null
    : findZipHit(listing, fqn) !== null;
}
