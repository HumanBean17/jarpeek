/**
 * Shared declaration-lexer contracts. The Java and Kotlin lexers produce
 * these shapes so every consumer treats both languages alike.
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
  /** Raw doc block including delimiters; never set for class files. */
  javadoc?: string;
  members: Declaration[];
}

export interface SourceFileDeclarations {
  file: string;
  pkg: string | null;
  /** Verbatim import statements (`import a.b.C;` / `import a.b.C as D`); source only. */
  imports: string[];
  classes: ParsedClass[];
  diagnostics: string[];
}
