/**
 * Shared type contracts for jarpeek.
 *
 * These are load-bearing: every resolver and query module consumes them.
 * Field names must stay stable.
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
  /** Raw javadoc/KDoc block verbatim, delimiters included; source provenance only. */
  javadoc?: string;
  receiverType?: string;
  modifiers?: string[];
  platform?: "expect" | "actual";
}

export interface DependencyArtifact {
  coordinates: string;
  configuration?: string;
  /**
   * "project" is the build's own root module and "module" a sibling build
   * module — both carry `sourceDirs` (package roots, walked live); external
   * jars carry binary/sources paths, "jdk" the local src.zip, "cache-scan"
   * a heuristic jar set.
   */
  kind: "external" | "module" | "project" | "jdk" | "cache-scan";
  binaryJar?: string;
  sourcesJar?: string;
  sourceDirs?: string[];
  noDecompile?: boolean;
}

/** Where a hit's artifact sits relative to the queried project. */
export type HitOrigin = "project" | "module" | "dependency" | "jdk" | "cache";

export interface ClassHit {
  fqn: string;
  coordinates: string;
  /** Parsed as the last `:`-segment of coordinates; empty for bare `jdk:` artifacts. */
  version: string;
  /** project | module | dependency | jdk | cache — the artifact's relation to the queried project. */
  origin: HitOrigin;
  kind: DeclKind;
  provenance: Provenance;
}
