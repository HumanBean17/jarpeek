/**
 * Shared type contracts for jarpeek.
 *
 * These are load-bearing: every indexer, resolver, and query module
 * consumes them. Field names must stay stable.
 */

export type Provenance = "source" | "decompiled" | "signature";

export type Visibility = "public" | "protected" | "package" | "private";

export type DeclKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "annotation"
  | "object"
  | "method"
  | "constructor"
  | "field"
  | "property"
  | "enum-constant";

export interface Declaration {
  /** Fully-qualified name of the declaring class. */
  fqn: string;
  /** `/`-separated jar entry or repo-relative source path. */
  file: string;
  /** Member name; the simple class name for class-level records. */
  selector: string;
  kind: DeclKind;
  visibility: Visibility;
  static: boolean;
  deprecated: boolean;
  /** One-line human-readable declaration. */
  signature: string;
  lineStart?: number;
  lineEnd?: number;
  javadocStart?: number;
  receiverType?: string;
  modifiers?: string[];
  platform?: "expect" | "actual";
}

export interface DependencyArtifact {
  coordinates: string;
  configuration?: string;
  kind: "external" | "module" | "jdk" | "cache-scan";
  binaryJar?: string;
  sourcesJar?: string;
  sourceDir?: string;
  classesDir?: string;
  provenance?: Provenance;
  noDecompile?: boolean;
  warnings?: string[];
  /**
   * Fingerprint of the sourceDir contents at index time (module artifacts):
   * hash over the walked source files' (relpath, size, mtimeMs) triples. A
   * mismatch means the indexed line ranges no longer describe the files on
   * disk. Absent on artifacts without a source dir and in older manifests.
   */
  sourceSig?: string;
}

export interface ClassHit {
  fqn: string;
  coordinates: string;
  /** Parsed as the last `:`-segment of coordinates; empty for bare `jdk:` artifacts. */
  version: string;
  kind: DeclKind;
  provenance: Provenance;
}
