/**
 * Outline: the frugal first look at a class — its declaration rows without
 * any source text.
 *
 * Lookup is listing-backed (Task 5): `locateClass` walks the manifest's
 * artifacts in order, and the first whose backing declares the fqn is parsed
 * from exactly one file — its own row, members, and directly nested class
 * rows come out of that parse. Later hits become `alternatives`. Lookup
 * misses are protocol, not errors to print: `LookupMissError` carries the
 * fqn so the miss layer can suggest alternatives.
 */
import type { Declaration, DeclKind, Provenance, Visibility } from "../types.js";
import { isStale } from "../../index/manifest.js";
import type { QueryContext } from "./context.js";
import { classFamily, locateClass } from "./locate.js";

/** Declaration kinds that name a type (vs members of one). */
export const CLASS_KINDS: readonly DeclKind[] = [
  "class",
  "interface",
  "enum",
  "record",
  "annotation",
  "object",
];

export const isClassKind = (kind: DeclKind): boolean =>
  (CLASS_KINDS as readonly string[]).includes(kind);

/** Thrown by outline/readSource when no listed artifact declares `fqn`. */
export class LookupMissError extends Error {
  constructor(public readonly fqn: string) {
    super(`no indexed class for ${fqn}`);
    this.name = "LookupMissError";
  }
}

export interface OutlineOptions {
  kind?: DeclKind;
  visibility?: Visibility;
  /** Section preset; `outline` when unspecified. */
  preset?: OutlinePreset;
  /** Per-section overrides of the preset; any defined field wins. */
  sections?: Partial<Sections>;
}

export interface OutlineResult {
  fqn: string;
  coordinates: string;
  provenance: Provenance;
  /** Present (and true) only when a stale index had to be served. */
  stale?: boolean;
  /** The winner file's imports — present iff the imports section is on AND the winner carried them. */
  imports?: string[];
  rows: Declaration[];
  alternatives?: Array<{ coordinates: string }>;
  degraded: string[];
}

/** The skeleton's named content sections, shared by CLI flags and MCP params. */
export type SectionName = "imports" | "fields" | "methods" | "inner" | "javadoc";

/** Effective per-section booleans after preset expansion and overrides. */
export type Sections = Record<SectionName, boolean>;

export type OutlinePreset = "minimal" | "outline" | "full";

/**
 * Preset → effective sections. `outline` and `full` are identical at data
 * level — they differ only in how the CLI renders javadoc and body markers.
 */
const PRESET_SECTIONS: Record<OutlinePreset, Sections> = {
  minimal: { imports: false, fields: false, methods: true, inner: true, javadoc: false },
  outline: { imports: true, fields: true, methods: true, inner: true, javadoc: true },
  full: { imports: true, fields: true, methods: true, inner: true, javadoc: true },
};

/**
 * The one resolver both surfaces share: preset first, then any defined
 * override field wins per-section. Pure — CLI flags and MCP params provably
 * produce the same booleans.
 */
export function resolveSections(
  preset: OutlinePreset | undefined,
  overrides: Partial<Sections> | undefined,
): Sections {
  const base = PRESET_SECTIONS[preset ?? "outline"];
  if (overrides === undefined) return { ...base };
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, on]) => on !== undefined),
  ) as Partial<Sections>;
  return { ...base, ...defined };
}

/** Declaration kinds that belong to the fields section. */
const FIELD_SECTION_KINDS: readonly DeclKind[] = ["field", "property", "enum-constant"];

/** Declaration kinds that belong to the methods section. */
const METHOD_SECTION_KINDS: readonly DeclKind[] = ["method", "constructor"];

/**
 * Apply effective sections to kind/visibility-filtered rows at data level —
 * JSON and MCP consumers get the same savings the skeleton render does. The
 * target class's own row is a class-kind row and is never dropped here.
 */
function applySections(
  rows: Declaration[],
  fqn: string,
  sections: Sections,
): Declaration[] {
  return rows
    .filter((row) => {
      if (!sections.fields && FIELD_SECTION_KINDS.includes(row.kind)) return false;
      if (!sections.methods && METHOD_SECTION_KINDS.includes(row.kind)) return false;
      if (!sections.inner && row.fqn !== fqn && classFamily(row.fqn, fqn)) return false;
      return true;
    })
    .map((row) =>
      sections.javadoc || row.javadoc === undefined ? row : omitJavadoc(row),
    );
}

/** Copy of the row without the javadoc property (keeps the original untouched). */
function omitJavadoc(row: Declaration): Declaration {
  const { javadoc: _dropped, ...rest } = row;
  return rest;
}

/** True when the served manifest no longer matches the build files / artifact paths. */
export async function servedStale(ctx: QueryContext): Promise<boolean> {
  const manifest = await ctx.manifest();
  return manifest !== null && isStale(ctx.projectRoot, manifest, ctx.buildTool);
}

/** Merge bootstrap warnings with per-call degradation, without duplicates. */
export async function mergedDegraded(ctx: QueryContext, extra: string[]): Promise<string[]> {
  return [...new Set([...(await ctx.bootstrapWarnings()), ...extra])];
}

/**
 * Declaration rows for `fqn`: the located winner's records (class row,
 * members, nested class rows) filtered by kind/visibility when given.
 */
export async function outline(
  ctx: QueryContext,
  fqn: string,
  opts: OutlineOptions = {},
): Promise<OutlineResult> {
  await ctx.ensureReady();
  const { winner, alternatives, degraded: locateDegraded } = await locateClass(ctx, fqn);
  const sections = resolveSections(opts.preset, opts.sections);
  const rows = applySections(
    winner.records.filter(
      (row) =>
        (opts.kind === undefined || row.kind === opts.kind) &&
        (opts.visibility === undefined || row.visibility === opts.visibility),
    ),
    fqn,
    sections,
  );
  const stale = await servedStale(ctx);
  return {
    fqn,
    coordinates: winner.artifact.coordinates,
    provenance: winner.provenance,
    ...(stale ? { stale: true } : {}),
    ...(sections.imports && winner.imports !== undefined ? { imports: winner.imports } : {}),
    rows,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    degraded: await mergedDegraded(ctx, [
      ...(stale ? ["stale index served"] : []),
      ...locateDegraded,
    ]),
  };
}
