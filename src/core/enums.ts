/**
 * The declaration-kind and visibility value lists: the one runtime source
 * of truth for every surface that names those values — the MCP zod schemas,
 * the CLI's choice-validated flags, and (through commander auto-rendering
 * declared choices) the help text. Order matters: it is the order error
 * messages and help print.
 */
import type { DeclKind, Visibility } from "./types.js";

/** Every declaration kind, as a runtime-validated enum (mirrors DeclKind). */
export const KIND_VALUES = [
  "class",
  "interface",
  "enum",
  "record",
  "annotation",
  "object",
  "method",
  "constructor",
  "field",
  "property",
  "enum-constant",
] as const satisfies readonly DeclKind[];

/** Compile-time: every DeclKind appears in KIND_VALUES, or this fails to build. */
type _KindExhaustive = Exclude<DeclKind, (typeof KIND_VALUES)[number]> extends never ? true : never;
// the use site is what makes the alias bite — a bare conditional type never errors
const _kindCheck: _KindExhaustive = true;

/** Visibility names, as a runtime-validated enum (mirrors Visibility). */
export const VISIBILITY_VALUES = [
  "public",
  "protected",
  "package",
  "private",
] as const satisfies readonly Visibility[];

/** Compile-time: every Visibility appears in VISIBILITY_VALUES. */
type _VisibilityExhaustive = Exclude<Visibility, (typeof VISIBILITY_VALUES)[number]> extends never
  ? true
  : never;
// same as above: the const forces the check to run
const _visibilityCheck: _VisibilityExhaustive = true;
