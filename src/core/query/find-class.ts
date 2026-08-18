/**
 * findClass: name → class hits, in the cheapest tier that answers.
 *
 * Listing-backed (Task 8): the manifest's artifacts are listed in order —
 * no store streaming — and each listing's class entries run the v1 tier
 * ladder: exact FQN, segment-aligned suffix, simple name (collected fully),
 * then fuzzy over simple names through a bounded keep-`limit` collector.
 * Hits carry the artifact's coordinates/version; the fqn is displayed
 * DOTTED (nesting spelled with `.`, the query layer's canonical form) while
 * tier matching runs on the listing fqn, which keeps `$`.
 *
 * Kind and provenance are refined for the RETURNED hits only, capped: a
 * binary hit parses one class file, a source hit one entry text, and beyond
 * a small constant the defaults stand — refinement is a display nicety, not
 * a reason to parse a whole dependency set. The provenance is a promise
 * (source when a source backing exists, decompiled when the JVM can get
 * there, signature otherwise), so it asks the JVM once per call through the
 * injectable `opts.jvm` seam.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactListing, ClassEntry } from "../listing.js";
import type { ClassHit, DeclKind, DependencyArtifact, Provenance } from "../types.js";
import { fuzzyScore } from "../fuzzy.js";
import { recordsFromClassBytes, recordsFromSourceText } from "../../parse/records.js";
import { readTextEntry, readZipEntry, type ZipEntry } from "../../parse/zip.js";
import { probeJvmOnce } from "../../util/jvm.js";
import type { QueryContext } from "./context.js";
import { classFamily } from "./locate.js";
import { mergedDegraded, servedStale } from "./outline.js";

export interface FindClassOptions {
  limit?: number;
  /**
   * JVM availability for the provenance promise — injectable so tests (and
   * any caller that already knows) never spawn `java`. Defaults to the
   * shared memoized probe.
   */
  jvm?: () => Promise<{ available: boolean }>;
}

export interface FindClassResult {
  hits: ClassHit[];
  degraded: string[];
}

/**
 * How many returned hits may be read+parsed for kind refinement. A constant,
 * not a multiple of limit: a broad query returning hundreds of hits must not
 * turn a name search into a whole-dependency-set parse. Hits beyond it keep
 * the unrefined `"class"` kind.
 */
const KIND_REFINEMENT_CAP = 24;

const UNORDERED = Number.MAX_SAFE_INTEGER;

/** Simple name of a listing fqn: after the last `.`, so `Outer$Inner` for nested (v1 parity). */
const simpleNameOf = (fqn: string): string => fqn.slice(fqn.lastIndexOf(".") + 1);

/** Dotted display form: the listing fqn with `$` nesting spelled as `.`. */
const displayFqn = (fqn: string): string => fqn.replaceAll("$", ".");

/** `query` equals the last N dot-segments of `fqn` (segment-aligned suffix). */
function suffixMatches(fqn: string, query: string): boolean {
  return query.includes(".") && (fqn === query || fqn.endsWith(`.${query}`));
}

/** Version = last `:`-segment of the coordinates; bare `jdk:` yields "". */
function versionOf(coordinates: string): string {
  const parts = coordinates.split(":");
  return parts[parts.length - 1] ?? "";
}

/** One tier entry: which artifact's which listing entry. */
interface Candidate {
  artifact: DependencyArtifact;
  listing: ArtifactListing;
  entry: ClassEntry;
  /** Position across all listings, in manifest order — the stable tiebreaker. */
  seq: number;
}

/** The zip entry named `name` in a listing, or undefined (readZipEntry needs the whole record). */
function zipEntryNamed(listing: ArtifactListing, name: string): ZipEntry | undefined {
  return listing.entries.find((e) => e.name === name);
}

/**
 * Fill the exact/suffix/simple tiers fully (deduped per coordinates+fqn) and
 * the fuzzy tier through a bounded keep-`limit` collector — v1's ordering
 * semantics: tier concatenation, manifest position first, iteration order
 * breaking ties. Listing fqns keep `$`, so an exact-tier query matches either
 * spelling (`Outer$Inner` entry = `Outer.Inner` query).
 */
async function collectTiers(
  ctx: QueryContext,
  query: string,
  limit: number,
): Promise<{ tiers: Candidate[][]; unreadable: string[] }> {
  const manifest = await ctx.manifest();
  const order = new Map<string, number>();
  (manifest?.artifacts ?? []).forEach((artifact, index) => {
    if (!order.has(artifact.coordinates)) order.set(artifact.coordinates, index);
  });

  const exact = new Map<string, Candidate>();
  const suffix = new Map<string, Candidate>();
  const simple = new Map<string, Candidate>();
  const fuzzy: Array<{ candidate: Candidate; score: number }> = [];
  const unreadable: string[] = [];
  let seq = 0;

  const manifestRank = (c: Candidate): number => order.get(c.artifact.coordinates) ?? UNORDERED;
  const byRank = (
    a: { candidate: Candidate; score: number },
    b: { candidate: Candidate; score: number },
  ): number => b.score - a.score || manifestRank(a.candidate) - manifestRank(b.candidate) || a.candidate.seq - b.candidate.seq;

  for (const artifact of manifest?.artifacts ?? []) {
    const listing = await ctx.listings.listing(artifact);
    if (listing.unreadable !== undefined) {
      unreadable.push(artifact.coordinates);
      continue;
    }
    for (const entry of listing.classes) {
      const fqn = entry.fqn;
      const simpleName = simpleNameOf(fqn);
      const candidate: Candidate = { artifact, listing, entry, seq: seq++ };
      const key = `${artifact.coordinates} ${fqn}`;

      if (fqn === query || fqn.replaceAll("$", ".") === query) {
        exact.set(key, candidate);
      } else if (suffixMatches(fqn, query)) {
        suffix.set(key, candidate);
      } else if (simpleName === query) {
        simple.set(key, candidate);
      } else {
        const score = fuzzyScore(query, simpleName);
        if (score === null) continue;
        if (
          fuzzy.some(
            (e) =>
              e.candidate.artifact.coordinates === artifact.coordinates &&
              e.candidate.entry.fqn === fqn,
          )
        ) {
          continue;
        }
        fuzzy.push({ candidate, score });
        if (fuzzy.length > Math.max(64, limit * 8)) {
          // bound memory: the survivors are provably ahead of everything dropped
          fuzzy.sort(byRank);
          fuzzy.length = limit;
        }
      }
    }
  }

  fuzzy.sort(byRank);
  const byManifestPosition = (a: Candidate, b: Candidate): number =>
    manifestRank(a) - manifestRank(b) || a.seq - b.seq;
  return {
    tiers: [
      [...exact.values()].sort(byManifestPosition),
      [...suffix.values()].sort(byManifestPosition),
      [...simple.values()].sort(byManifestPosition),
      fuzzy.map((e) => e.candidate),
    ],
    unreadable,
  };
}

/**
 * The kind of one returned hit, parsed from exactly its own entry. Binary
 * backings parse the class bytes and keep the equal-dotted-fqn class row's
 * kind (the class-file reader maps `$` to `.`, so the rows match the dotted
 * display form); source backings parse the entry text and keep the
 * `classFamily`-matching row's kind (a source file declares its nested
 * classes too). No matching record → the `"class"` default stands.
 */
async function refinedKind(candidate: Candidate): Promise<DeclKind> {
  const { artifact, listing, entry } = candidate;
  const dotted = displayFqn(entry.fqn);
  const want = (record: { fqn: string; selector: string }): boolean =>
    record.selector === simpleNameOf(dotted) && classFamily(record.fqn, dotted);
  try {
    if (listing.source === "binary") {
      const zipEntry = zipEntryNamed(listing, entry.entry);
      if (zipEntry === undefined) return "class";
      const { records } = recordsFromClassBytes(
        await readZipEntry(artifact.binaryJar!, zipEntry),
        entry.entry,
        entry.entry,
      );
      return records.find(want)?.kind ?? "class";
    }
    if (listing.source === "sourceDir") {
      // readFileSync throws sync; the async wrapper keeps one try/catch honest
      const text = await (async () => readFileSync(join(artifact.sourceDir!, entry.entry), "utf8"))();
      return recordsFromSourceText(text, entry.entry).records.find(want)?.kind ?? "class";
    }
    const zipEntry = zipEntryNamed(listing, entry.entry);
    if (zipEntry === undefined) return "class";
    const text = await readTextEntry(artifact.sourcesJar!, zipEntry);
    return recordsFromSourceText(text, entry.entry).records.find(want)?.kind ?? "class";
  } catch {
    // a read or parse failure degrades to the default kind: the hit still
    // answers WHERE the class is
    return "class";
  }
}

/**
 * The provenance PROMISE per hit, not a per-artifact memo: which artifact and
 * backing the hit came from decides what reading it fully would yield. The
 * JVM is asked at most once per call (lazily — an all-source answer never
 * spawns).
 */
async function promisedProvenance(
  candidate: Candidate,
  jvmAvailable: () => Promise<boolean>,
): Promise<Provenance> {
  const { artifact } = candidate;
  if (artifact.sourcesJar !== undefined || artifact.sourceDir !== undefined) return "source";
  if (artifact.binaryJar !== undefined && (await jvmAvailable())) return "decompiled";
  return "signature";
}

/**
 * Find classes by exact FQN, segment-aligned suffix, simple name, or fuzzy
 * simple-name subsequence — in that order. Bootstraps (manifest ensureReady)
 * first; tiers concatenate with v1 ordering semantics, the fuzzy tier sliced
 * to `limit`.
 */
export async function findClass(
  ctx: QueryContext,
  query: string,
  opts: FindClassOptions = {},
): Promise<FindClassResult> {
  const limit = opts.limit ?? 20;
  const jvm = opts.jvm ?? probeJvmOnce;
  await ctx.ensureReady();

  const { tiers, unreadable } = await collectTiers(ctx, query, limit);

  // ordered tier-concatenated hits; refinement values key on (coordinates, fqn)
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const keyOf = (c: Candidate): string => `${c.artifact.coordinates} ${displayFqn(c.entry.fqn)}`;
  for (const [tierIndex, tier] of tiers.entries()) {
    for (const candidate of tierIndex === 3 ? tier.slice(0, limit) : tier) {
      const key = keyOf(candidate);
      // first occurrence wins for refinement; the hit itself still lists once
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  // refine only the returned hits, and only up to the cap — beyond it the
  // "class" default stands (a name search must not parse a whole dependency set)
  const kinds = new Map<string, DeclKind>();
  for (const candidate of candidates.slice(0, KIND_REFINEMENT_CAP)) {
    kinds.set(keyOf(candidate), await refinedKind(candidate));
  }

  // the JVM question decides every binary-only hit the same way: one probe
  let probed: Promise<boolean> | undefined;
  const jvmAvailable = (): Promise<boolean> =>
    (probed ??= jvm().then((r) => r.available));
  const provenances = new Map<string, Promise<Provenance>>();
  for (const candidate of candidates) {
    const key = keyOf(candidate);
    if (!provenances.has(key)) {
      provenances.set(key, promisedProvenance(candidate, jvmAvailable));
    }
  }

  const hits: ClassHit[] = await Promise.all(
    candidates.map(async (candidate): Promise<ClassHit> => {
      const coordinates = candidate.artifact.coordinates;
      const fqn = displayFqn(candidate.entry.fqn);
      return {
        fqn,
        coordinates,
        version: versionOf(coordinates),
        kind: kinds.get(keyOf(candidate)) ?? "class",
        provenance: await provenances.get(keyOf(candidate))!,
      };
    }),
  );

  const stale = await servedStale(ctx);
  const extra: string[] = [...(stale ? ["stale index served"] : [])];
  if (unreadable.length > 0) {
    extra.push(`${unreadable.length} artifacts unreadable (${unreadable.slice(0, 3).join(", ")})`);
  }
  return { hits, degraded: await mergedDegraded(ctx, extra) };
}
