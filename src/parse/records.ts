/**
 * One-file record extraction for the lazy query paths.
 *
 * Everything here turns a single parsed unit — one source text or one
 * compiled class buffer — into `Declaration` records, with no knowledge of
 * where the bytes came from (jar entry, source dir, compiled class file)
 * or where the records go. Every caller reuses these per file on demand.
 * Failures are returned, never thrown: a
 * corrupt class file becomes a `warning`, and every branch keeps the
 * record/warning shape its caller already expects.
 */
import { basename } from "node:path";
import type { Declaration } from "../core/types.js";
import type { ParsedClass } from "./declarations.js";
import { parseClassFile } from "./classfile.js";
import { parseJavaSource } from "./java-lexer.js";
import { parseKotlinSource } from "./kotlin-lexer.js";

/** Class entries that carry no declarations worth indexing. */
const EXCLUDED_CLASS_FILES = new Set(["module-info.class", "package-info.class"]);

/** True for `.class` entries minus the info files that carry no declarations. */
export const isClassEntry = (name: string): boolean =>
  name.endsWith(".class") && !EXCLUDED_CLASS_FILES.has(basename(name));

/**
 * Anonymous and local classes compile to digit simple names (`Outer$1` →
 * `Outer.1`); synthetic lambda shapes surface the same way. None of them are
 * navigation targets, so the whole class record — members included — is
 * dropped when the last fqn segment does not start a Java identifier.
 */
export const isIndexableClass = (fqn: string): boolean =>
  /^[A-Za-z_]/.test(fqn.slice(fqn.lastIndexOf(".") + 1));

/** Fields shared by ParsedClass and ParsedClassFile, minus the members. */
export type ClassRecordSource = Pick<
  ParsedClass,
  "fqn" | "kind" | "visibility" | "static" | "deprecated" | "signature"
> &
  Partial<Pick<ParsedClass, "lineStart" | "lineEnd" | "javadocStart" | "javadoc">>;

/** Class-level Declaration: selector is the simple name, per the query contract. */
export function classRecord(cls: ClassRecordSource, file: string): Declaration {
  return {
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
    ...(cls.javadoc !== undefined ? { javadoc: cls.javadoc } : {}),
  };
}

/**
 * Parse one source text into class + member records. Lexers never throw;
 * their per-file diagnostics are returned for the caller to turn into
 * `failed to index` warnings.
 */
export function recordsFromSourceText(
  text: string,
  file: string,
): { records: Declaration[]; diagnostics: string[]; imports: string[] } {
  const parsed = file.endsWith(".kt") ? parseKotlinSource(text, file) : parseJavaSource(text, file);
  const records: Declaration[] = [];
  for (const cls of parsed.classes) {
    records.push(classRecord(cls, file));
    for (const member of cls.members) {
      records.push({ ...member, fqn: cls.fqn, file });
    }
  }
  return { records, diagnostics: parsed.diagnostics, imports: parsed.imports };
}

/** One compiled class buffer → class + member records, or a warning on failure. */
export function recordsFromClassBytes(
  buf: Buffer,
  file: string,
  label: string,
): { records: Declaration[]; warning?: string } {
  let parsed;
  try {
    parsed = parseClassFile(buf);
  } catch (e) {
    return { records: [], warning: `failed to index ${label}: ${(e as Error).message}` };
  }
  if (!isIndexableClass(parsed.fqn)) return { records: [] };
  const records = [classRecord(parsed, file)];
  for (const member of parsed.members) {
    records.push({ ...member, fqn: parsed.fqn, file });
  }
  return { records };
}
