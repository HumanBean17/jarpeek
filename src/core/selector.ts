/**
 * Member selector grammar and declaration matching.
 *
 * `#name` / `#name()` / `#name(T1, T2)` / `#name(*)` / `#Receiver.name(...)`
 * is the addressing scheme read_member accepts. parseSelector is strict
 * (every malformed form is a SelectorError with a usage message, so the CLI
 * can surface it verbatim), while matchDeclarations is generous on purpose:
 * written parameter types come from three producers with different spelling
 * conventions (Java sources use simple names, class files use fully
 * qualified ones, Kotlin adds spaces, nullability marks, and modifier
 * prefixes), so each selector param matches on normalized equality or
 * simple-name agreement after the written type is normalized. Overloads are never
 * silently picked — a bare name returns every record with that name and the
 * caller decides how to disambiguate.
 */
import type { Declaration } from "./types.js";

export interface Selector {
  /** Member name (or class simple name for class-level records). */
  name: string;
  /** `null` = any arity; `[]` = exactly zero params; `["*"]` = any arity. */
  params: string[] | null;
  /** Kotlin extension receiver simple name, when `#Receiver.name` was written. */
  receiver?: string;
}

export class SelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorError";
  }
}

const USAGE =
  "Usage: #name, #name(), #name(T1, T2), #name(*), or #Receiver.name(...); " +
  'parameter types may use [A-Za-z0-9_.$<>\\[\\], ] characters only';

function fail(detail: string): never {
  throw new SelectorError(`${detail}. ${USAGE}`);
}

/** Split on commas at depth 0, tracking `<>`, `()`, and `[]` nesting. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "," && angle === 0 && paren === 0 && bracket === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Parse one selector. The head is matched strictly against the identifier
 * grammar; the parameter list is split depth-aware so generic commas
 * (`Map<String,String>`) stay inside one type, and every character outside
 * the allowed set, plus trailing/double commas, is an error.
 */
export function parseSelector(raw: string): Selector {
  const m = /^#([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)(?:\((.*)\))?$/.exec(raw);
  if (!m) {
    if (!raw.startsWith("#")) fail(`selector must start with "#": ${JSON.stringify(raw)}`);
    fail(`malformed selector ${JSON.stringify(raw)}`);
  }
  let name = m[1]!;
  let receiver: string | undefined;
  // The last `.` separates receiver from member name; earlier dots stay in
  // the receiver, which receiverMatches compares against the record's
  // normalized receiverType simple name — so `#a.b.C.run` targets a record
  // whose receiverType simple name is `C`, however it was spelled.
  const dot = name.lastIndexOf(".");
  if (dot !== -1) {
    receiver = name.slice(0, dot);
    name = name.slice(dot + 1);
  }
  const sel: Selector = { name, params: null };
  if (receiver !== undefined) sel.receiver = receiver;
  if (m[2] === undefined) return sel; // no parens written: any arity
  if (m[2].trim() === "") {
    sel.params = [];
    return sel;
  }
  const groups = splitTopLevel(m[2]).map((g) => g.trim());
  const params: string[] = [];
  for (const param of groups) {
    if (param === "") fail(`empty parameter type in ${JSON.stringify(raw)}`);
    if (param === "*") {
      if (groups.length > 1) fail(`"*" must be the only parameter in ${JSON.stringify(raw)}`);
      sel.params = ["*"];
      return sel;
    }
    // Commas are legal here: splitTopLevel already proved any comma sits at
    // depth 0 or inside a generic's `<>`, where it belongs to one type.
    if (!/^[A-Za-z0-9_.$<>[\], ]+$/.test(param)) {
      fail(`invalid character in parameter type ${JSON.stringify(param)}`);
    }
    params.push(param);
  }
  sel.params = params;
  return sel;
}

/**
 * Split a comma-separated selector list on depth-0 commas only, so selector
 * parentheses (`#a(String,int)`) and generic types survive intact.
 */
export function splitSelectorList(raw: string): string[] {
  return splitTopLevel(raw)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Text between the outermost `(...)` of a signature, or null when absent. */
function outerParenBody(signature: string): string | null {
  const open = signature.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return signature.slice(open + 1, i);
    }
  }
  return signature.slice(open + 1); // unterminated: take the rest
}

/**
 * Written parameter types from a signature: the outermost paren group split
 * on depth-0 commas, each group whitespace-stripped. `[]` for an empty
 * paren group, null for signatures without parens (fields, properties).
 */
function writtenParams(signature: string): string[] | null {
  const body = outerParenBody(signature);
  if (body === null) return null;
  if (body.trim() === "") return [];
  return splitTopLevel(body)
    .map((s) => s.replace(/\s+/g, ""))
    .filter((s) => s.length > 0);
}

/**
 * Normalize a WRITTEN type for comparison: collapse whitespace, strip
 * trailing nullability marks (`String?`, even `String??`), trailing Java
 * varargs (`T...`), and leading Kotlin meaning-modifiers (`vararg`,
 * `noinline`, `crossinline`) that say how a param is passed, not what it
 * is. The selector side is never touched — its grammar stays strict.
 */
function normalizeWritten(type: string): string {
  let t = type.replace(/\s+/g, "");
  t = t.replace(/(\?)+$/, "");
  t = t.replace(/\.{3}$/, "");
  for (;;) {
    const m = /^(?:vararg|noinline|crossinline)(?=[A-Za-z0-9_$])/.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t;
}

/**
 * One selector param against one written type. The written side is
 * normalized (whitespace, nullability, varargs, modifiers), then the match
 * is normalized equality or simple-name agreement in either direction —
 * the selector may spell `java.lang.String` where the source wrote
 * `String`, or the reverse for class-file signatures.
 */
function paramMatches(param: string, written: string): boolean {
  const w = normalizeWritten(written);
  const p = param.replace(/\s+/g, "");
  if (p === "*") return true;
  if (w === p) return true;
  const simple = (s: string): string => s.slice(s.lastIndexOf(".") + 1);
  return simple(w) === simple(p) || w.endsWith("." + p);
}

function receiverMatches(sel: Selector, rec: Declaration): boolean {
  if (sel.receiver === undefined) return true;
  if (rec.receiverType === undefined) return false;
  // simple-to-simple: the selector's receiver may be spelled fully qualified
  // (`#a.b.C.run`), and so may the record's receiverType — compare the last
  // `.`-segment of both
  return (
    normalizeWritten(rec.receiverType).split(".").pop() === sel.receiver.split(".").pop()
  );
}

/**
 * Filter records by a parsed selector: exact name, arity (via depth-0 comma
 * counting), per-parameter type equivalence, and extension receiver. All
 * matches are returned — overload expansion is the caller's job.
 */
export function matchDeclarations(records: Declaration[], sel: Selector): Declaration[] {
  return records.filter((rec) => {
    if (rec.selector !== sel.name) return false;
    if (!receiverMatches(sel, rec)) return false;
    if (sel.params === null || (sel.params.length === 1 && sel.params[0] === "*")) return true;
    const written = writtenParams(rec.signature);
    // A paren-arity selector never matches paren-less records (fields).
    if (written === null) return false;
    if (sel.params.length === 0) return written.length === 0;
    if (written.length !== sel.params.length) return false;
    return sel.params.every((p, i) => paramMatches(p, written[i]!));
  });
}
