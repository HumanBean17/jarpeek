/**
 * Shared declaration-lexer contracts. The Java and Kotlin lexers produce
 * these shapes so the indexer downstream treats both languages alike.
 */
import type { Declaration, Visibility } from "../core/types.js";

export interface ParsedClass {
  fqn: string;
  /** "object" is Kotlin-only (object/companion declarations). */
  kind: "class" | "interface" | "enum" | "record" | "annotation" | "object";
  visibility: Visibility;
  static: boolean;
  deprecated: boolean;
  signature: string;
  lineStart: number;
  lineEnd: number;
  javadocStart?: number;
  members: Declaration[];
}

export interface SourceFileDeclarations {
  file: string;
  pkg: string | null;
  classes: ParsedClass[];
  diagnostics: string[];
}
