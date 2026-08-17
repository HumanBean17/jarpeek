/**
 * readMember: the source slices behind a selector list.
 *
 * Where read_source serves a whole file, read_member serves exactly the
 * declarations an agent asked for — javadoc included — so a batch of
 * `#name(T1,T2)` selectors costs a handful of lines, not a class body. The
 * content ladder is read_source's: module sources, sources jar (JDK src.zip
 * included), then a whole-class decompile whose listing is re-lexed so line
 * numbers and javadoc ranges refer to the decompiled text. When no real
 * source exists (no JVM to decompile, JDK classes where decompilation is out
 * of scope, a failed decompile) every served selector still yields its
 * signature as a pseudo-member plus a miss entry naming the reason — the
 * call degrades, it never fails. Malformed selectors, by contrast, are a
 * usage error: parseSelector throws for the whole call and the miss protocol
 * does not apply.
 */
import { parseJavaSource } from "../../parse/java-lexer.js";
import { runWithTimeout } from "../../util/exec.js";
import { sliceLines } from "../../util/lines.js";
import type { Declaration, DependencyArtifact, Provenance } from "../types.js";
import { matchDeclarations, parseSelector, splitSelectorList } from "../selector.js";
import type { QueryContext } from "./context.js";
import { resolveContent, type ResolvedContent } from "./read-source.js";

export interface ReadMemberOptions {
  /** Injectable exec (tests) threaded to the decompiler. */
  exec?: typeof runWithTimeout;
}

export interface MemberSlice {
  /** Disambiguated: `run(String,int)` for methods, the plain name for fields. */
  selector: string;
  signature: string;
  /** `[javadocStart ?? lineStart, lineEnd]` of the class's file; `[signature]` when degraded. */
  lines: string[];
  /** 1-based; 0 for pseudo-members. */
  startLine: number;
  endLine: number;
  /** The javadoc lines above the declaration, when the record carries javadocStart. */
  javadoc?: string[];
}

export interface ReadMemberResult {
  fqn: string;
  coordinates: string;
  provenance: Provenance;
  stale?: boolean;
  members: MemberSlice[];
  misses: Array<{ selector: string; reason: string }>;
  /** Other artifacts declaring the same fqn, when the winner had collisions. */
  alternatives?: Array<{ coordinates: string }>;
  /** Bootstrap + resolution degradations (misaligned module source, ...). */
  degraded: string[];
}

/**
 * Written parameter types of a signature as simple names (`String`, `int`),
 * depth-0-comma split so generic commas stay inside one type. `null` when the
 * signature has no paren group (fields, properties).
 */
function writtenSimpleParams(signature: string): string[] | null {
  const open = signature.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = close === -1 ? signature.slice(open + 1) : signature.slice(open + 1, close);
  if (body.trim() === "") return [];

  const params: string[] = [];
  let current = "";
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  for (const ch of body) {
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "," && angle === 0 && paren === 0 && bracket === 0) {
      params.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  params.push(current);
  return params
    .map((param) => {
      const type = param.replace(/\s+/g, "");
      return type.slice(type.lastIndexOf(".") + 1);
    })
    .filter((type) => type.length > 0);
}

/** `run` + `public Object run(String,int)` → `run(String,int)`; fields keep their name. */
function disambiguatedSelector(record: Declaration): string {
  const params = writtenSimpleParams(record.signature);
  if (params === null) return record.selector;
  return `${record.selector}(${params.join(",")})`;
}

/** Class + member records re-lexed from a decompiled listing (line numbers refer to it). */
function decompiledRecords(source: string, file: string, fqn: string): Declaration[] {
  const parsed = parseJavaSource(source, file);
  const cls = parsed.classes.find((candidate) => candidate.fqn === fqn);
  if (cls === undefined) return [];
  const records: Declaration[] = [
    {
      fqn: cls.fqn,
      file,
      selector: cls.fqn.slice(cls.fqn.lastIndexOf(".") + 1),
      kind: cls.kind,
      visibility: cls.visibility,
      static: cls.static,
      deprecated: cls.deprecated,
      signature: cls.signature,
      ...(cls.lineStart !== undefined ? { lineStart: cls.lineStart, lineEnd: cls.lineEnd } : {}),
      ...(cls.javadocStart !== undefined ? { javadocStart: cls.javadocStart } : {}),
    },
    ...cls.members.map((member) => ({ ...member, fqn: cls.fqn, file })),
  ];
  return records;
}

/** Miss reason explaining why a served selector is only a signature row. */
function degradeReason(meta: DependencyArtifact, resolved: ResolvedContent): string {
  if (meta.noDecompile || meta.kind === "jdk") return "jdk: decompilation out of scope";
  const decompile = resolved.decompile;
  if (decompile !== undefined && decompile.provenance === "signature") {
    if (decompile.reason === "no-jvm") return "no-jvm (decompile unavailable)";
    return `decompile failed${decompile.detail ? `: ${decompile.detail}` : ""}`;
  }
  return "no source available";
}

function memberSlice(record: Declaration, content: string, pseudo: boolean): MemberSlice {
  const selector = disambiguatedSelector(record);
  if (pseudo || record.lineStart === undefined || record.lineEnd === undefined) {
    return { selector, signature: record.signature, lines: [record.signature], startLine: 0, endLine: 0 };
  }
  const sliced = sliceLines(content, record.javadocStart ?? record.lineStart, record.lineEnd);
  return {
    selector,
    signature: record.signature,
    lines: sliced.lines,
    startLine: sliced.startLine,
    endLine: sliced.endLine,
    ...(record.javadocStart !== undefined && record.javadocStart < record.lineStart
      ? { javadoc: sliceLines(content, record.javadocStart, record.lineStart - 1).lines }
      : {}),
  };
}

/**
 * Serve the members a comma-separated selector list names. SelectorError
 * propagates (malformed input is not a miss); LookupMissError propagates for
 * an unknown class (the miss protocol's job, not this one's).
 */
export async function readMember(
  ctx: QueryContext,
  fqn: string,
  selectorsRaw: string,
  opts: ReadMemberOptions = {},
): Promise<ReadMemberResult> {
  // parse the whole list up front: one malformed selector fails the call
  const selectors = splitSelectorList(selectorsRaw).map((raw) => ({ raw, sel: parseSelector(raw) }));

  const source = await resolveContent(ctx, fqn, { exec: opts.exec });

  let records: Declaration[];
  let degradedReason: string | undefined;
  if (source.provenance === "decompiled") {
    // the indexed records carry no line numbers; the listing's own do
    records = decompiledRecords(source.content, source.file, fqn);
  } else if (source.provenance === "signature") {
    records = source.records;
    degradedReason = degradeReason(source.meta, source);
  } else {
    records = source.records;
  }

  const members: MemberSlice[] = [];
  const misses: Array<{ selector: string; reason: string }> = [];
  for (const { raw, sel } of selectors) {
    const matches = matchDeclarations(records, sel);
    if (matches.length === 0) {
      misses.push({ selector: raw, reason: "no matching declaration" });
      continue;
    }
    if (degradedReason !== undefined) {
      misses.push({ selector: raw, reason: degradedReason });
    }
    members.push(...matches.map((record) => memberSlice(record, source.content, degradedReason !== undefined)));
  }

  return {
    fqn,
    coordinates: source.coordinates,
    provenance: source.provenance,
    ...(source.stale ? { stale: true } : {}),
    members,
    misses,
    ...(source.alternatives.length > 0 ? { alternatives: source.alternatives } : {}),
    degraded: source.degraded,
  };
}
