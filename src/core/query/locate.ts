/**
 * Locate: listings-backed FQN → artifact location and one-file record
 * parsing — the store's replacement. The manifest's artifacts are listed in
 * order (ListingService caches per coordinates+stamp) and the first whose
 * backing declares the fqn is parsed from exactly one file: its source entry
 * or its compiled class entry, plus one class row per directly nested class
 * entry. Later hits become `alternatives`; unreadable artifacts and entries
 * that failed to read or parse become aggregated `degraded` notes — the only
 * throw is the LookupMissError protocol. `recordsForArtifact` reuses the same
 * listing+parse plumbing to feed search_symbols a whole artifact at a time,
 * memoized by coordinates+stamp.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactListing, ListingService } from "../listing.js";
import type { Declaration, DependencyArtifact, Provenance } from "../types.js";
import type { Manifest } from "../../index/manifest.js";
import { recordsFromClassBytes, recordsFromSourceText } from "../../parse/records.js";
import { readTextEntry, readZipEntry, type ZipEntry } from "../../parse/zip.js";
import { isClassKind, LookupMissError } from "./outline.js";

/**
 * Parse one artifact's whole backing: every source entry (sources/sourceDir
 * backings) or every class entry (binary), the record set `search_symbols`
 * ranks over. `unreadable` aggregates both a backing that would not list and
 * per-entry parse failures (count + first labels) — a partial answer with an
 * honest note beats a throw.
 */
export interface ArtifactRecords {
  records: Declaration[];
  provenance: Provenance;
  unreadable?: string;
}

/**
 * The per-entry parse seam: entry name in, that entry's records plus its
 * diagnostics (source) or warning (class bytes) out. Injectable so the
 * memoization tests can count parses; the default is the real parser pair.
 */
export type ParseEntries = (
  entries: readonly string[],
) => Promise<Array<{ entry: string; records: Declaration[]; diagnostics?: string[]; warning?: string }>>;

export interface RecordsForArtifactOptions {
  /** Test-only parse injection (memoization counts); default parses for real. */
  parseEntries?: ParseEntries;
}

/**
 * Memoized `recordsForArtifact` results by coordinates, each pinned to the
 * listing stamp it was parsed from. A stamp change (rebuilt jar, edited
 * source dir) re-parses; an unreadable cached result is retried the same way,
 * so a fixed jar recovers on the next query.
 */
const recordsMemo = new Map<string, { stamp: string; value: ArtifactRecords }>();

/** Default options literal shared by every caller that does not inject. */
const NO_OPTIONS: RecordsForArtifactOptions = {};

/**
 * How many entries `recordsForArtifact` parses concurrently. Each jar read
 * opens the archive independently, so an unbounded fan-out would hold one fd
 * per entry and EMFILE somewhere around the common 1024-fd soft limit — a
 * 3000-class jar would lose most of its entries to "failed to parse". A small
 * constant keeps peak fds bounded while still overlapping I/O.
 */
export const PARSE_POOL_SIZE = 8;

/**
 * `items.map(fn)` with at most `pool` fns in flight, results in input order.
 * Workers pull the next index as they finish — no per-item promise is created
 * ahead of its turn, so the in-flight bound holds no matter how long the list.
 */
export async function mapWithPool<T, R>(
  items: readonly T[],
  pool: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, items.length) }, worker));
  return results;
}

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
  deps: LocateDeps,
  artifact: DependencyArtifact,
  listing: ArtifactListing,
  fqn: string,
  includeNested: boolean,
  scan: Scan,
): Promise<LocatedClass | null> {
  // the winner PARSES from the first source-ish backing that carries the
  // entry — the spec's provenance ladder, so a both-jars artifact serves
  // source text, never bytecode/decompile output. A source hit also ANSWERS
  // the hit test (a sources jar can declare a class the binary lacks);
  // otherwise the preferred listing's own backing serves.
  const parse = await parseBackingFor(deps, artifact, fqn, includeNested, scan);
  if (parse !== null) return parse;
  const hit = findHit(listing, fqn);
  if (hit === null) return null;
  // nothing source-ish yields the entry: fall back to the hit's own backing
  if (listing.source === "sourceDir") {
    const root = artifact.sourceDir!;
    return sourceLocated(
      artifact,
      hit.name,
      // readFileSync throws sync on a vanished file; the async wrapper keeps
      // sourceLocated's single try/catch honest for both backings
      async () => readFileSync(join(root, hit.name), "utf8"),
      fqn,
      includeNested,
      scan,
    );
  }
  const zipHit = findZipHit(listing, fqn);
  return zipHit === null
    ? null
    : listing.source === "binary"
      ? binaryLocated(artifact, listing, zipHit, fqn, includeNested, scan)
      : sourceLocated(
          artifact,
          zipHit.name,
          () => readTextEntry(artifact.sourcesJar!, zipHit),
          fqn,
          includeNested,
          scan,
        );
}

/** Hit test over either listing kind: the entry name (relpath) or null. */
function findHit(listing: ArtifactListing, fqn: string): { name: string } | null {
  if (listing.source === "sourceDir") {
    const relpath = findSourceDirHit(listing, fqn);
    return relpath === null ? null : { name: relpath };
  }
  const hit = findZipHit(listing, fqn);
  return hit === null ? null : { name: hit.name };
}

/**
 * The first SOURCE-ish backing (sourceDir, then sourcesJar) that yields the
 * dotted `fqn`'s entry, parsed — or null when neither does (binary callers
 * fall back to their own backing). An unreadable requested backing counts as
 * not yielding: the binary hit still answers.
 */
async function parseBackingFor(
  deps: LocateDeps,
  artifact: DependencyArtifact,
  fqn: string,
  includeNested: boolean,
  scan: Scan,
): Promise<LocatedClass | null> {
  if (artifact.sourceDir !== undefined) {
    const listing = await deps.listings.listing(artifact, { backing: "sourceDir" });
    if (listing.unreadable === undefined) {
      const relpath = findSourceDirHit(listing, fqn);
      if (relpath !== null) {
        const root = artifact.sourceDir;
        return sourceLocated(
          artifact,
          relpath,
          async () => readFileSync(join(root, relpath), "utf8"),
          fqn,
          includeNested,
          scan,
        );
      }
    }
  }
  if (artifact.sourcesJar !== undefined) {
    const listing = await deps.listings.listing(artifact, { backing: "sources" });
    if (listing.unreadable === undefined) {
      const hit = findZipHit(listing, fqn);
      if (hit !== null) {
        return sourceLocated(
          artifact,
          hit.name,
          () => readTextEntry(artifact.sourcesJar!, hit),
          fqn,
          includeNested,
          scan,
        );
      }
    }
  }
  return null;
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
      winner = await locateInListing(deps, artifact, listing, fqn, includeNested, scan);
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

/**
 * Parse one entry of `artifact`'s `listing` into records. Source backings
 * read text and lex it (a read throw degrades to a labeled failure, never
 * aborts the artifact); binary backings read the class bytes. `zipByName` is
 * the caller's one-shot name→entry map — per-entry lookup stays O(1) instead
 * of a linear scan per class. Diagnostics and warnings are returned, not
 * thrown, so the caller aggregates.
 */
async function parseOneEntry(
  artifact: DependencyArtifact,
  listing: ArtifactListing,
  zipByName: Map<string, ZipEntry>,
  entryName: string,
): Promise<{ records: Declaration[]; diagnostics?: string[]; warning?: string }> {
  if (listing.source === "sourceDir") {
    const root = artifact.sourceDir!;
    try {
      // readFileSync throws sync on a vanished file; the async wrapper keeps
      // one try/catch honest for both dir and jar backings
      const text = await (async () => readFileSync(join(root, entryName), "utf8"))();
      return recordsFromSourceText(text, entryName);
    } catch {
      return { records: [], diagnostics: [`failed to read ${entryName}`] };
    }
  }
  const zipEntry = zipByName.get(entryName);
  if (zipEntry === undefined) {
    return { records: [], diagnostics: [`missing entry ${entryName}`] };
  }
  if (listing.source === "binary") {
    const jar = artifact.binaryJar!;
    try {
      return recordsFromClassBytes(await readZipEntry(jar, zipEntry), entryName, entryName);
    } catch {
      return { records: [], warning: `failed to read ${entryName}` };
    }
  }
  const jar = artifact.sourcesJar!;
  try {
    return recordsFromSourceText(await readTextEntry(jar, zipEntry), entryName);
  } catch {
    return { records: [], diagnostics: [`failed to read ${entryName}`] };
  }
}

/**
 * Every record of ONE artifact: sources/sourceDir backings parse every
 * source entry (provenance `source`), binary backings every class entry
 * (provenance `signature`). The result is memoized by coordinates against
 * the listing's stamp — an unchanged jar costs nothing on the second query —
 * and nothing here ever throws: an unreadable backing or per-entry parse
 * failures land in `unreadable` (count + first labels) with whatever records
 * did parse.
 */
export async function recordsForArtifact(
  deps: LocateDeps,
  artifact: DependencyArtifact,
  opts: RecordsForArtifactOptions = NO_OPTIONS,
): Promise<ArtifactRecords> {
  const listing = await deps.listings.listing(artifact);
  const cached = recordsMemo.get(artifact.coordinates);
  // an unreadable listing carries no entries, so its stamp keys an empty
  // result — retrying on every call would re-list for nothing; caching it is
  // the same contract the ListingService itself gives unreadable results
  if (cached !== undefined && cached.stamp === listing.stamp) {
    return cached.value;
  }

  if (listing.unreadable !== undefined) {
    const value: ArtifactRecords = { records: [], provenance: "signature", unreadable: listing.unreadable };
    recordsMemo.set(artifact.coordinates, { stamp: listing.stamp, value });
    return value;
  }

  const parseEntries =
    opts.parseEntries ??
    (async (entries: readonly string[]) => {
      // one name→entry map per call: a per-entry `entries.find` would scan the
      // whole central directory for every class (O(entries²) on a big jar)
      const zipByName = new Map(listing.entries.map((entry) => [entry.name, entry]));
      // bounded pool, NOT Promise.all: each read opens the jar, and an
      // unbounded fan-out would peak at one fd per entry (EMFILE on real jars)
      return mapWithPool(entries, PARSE_POOL_SIZE, async (entry) => ({
        entry,
        ...(await parseOneEntry(artifact, listing, zipByName, entry)),
      }));
    });
  const failures: string[] = [];
  let failed = 0;
  const records: Declaration[] = [];
  for (const parsed of await parseEntries(listing.classes.map((cls) => cls.entry))) {
    records.push(...parsed.records);
    const problem = parsed.diagnostics?.[0] ?? parsed.warning;
    if (parsed.diagnostics?.length || parsed.warning !== undefined) {
      failed++;
      if (problem !== undefined && failures.length < 3) failures.push(problem);
    }
  }
  const value: ArtifactRecords = {
    records,
    provenance: listing.source === "binary" ? "signature" : "source",
    ...(failed > 0
      ? { unreadable: `${failed} entries failed to parse (${failures.join(", ")})` }
      : {}),
  };
  recordsMemo.set(artifact.coordinates, { stamp: listing.stamp, value });
  return value;
}
