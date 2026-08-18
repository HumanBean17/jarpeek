/**
 * The Java-shaped skeleton renderer: outline rows as copy-pasteable code.
 *
 * Metadata renders as `//` comment lines so the body stays source-shaped;
 * members render from `Declaration.signature` verbatim, one per line,
 * indented 4 spaces per nesting level — nothing is ever clipped (no columns
 * exist to align). Pure: no I/O, no environment, the same input always
 * renders the same text.
 */
import type { Declaration, Provenance } from "../core/types.js";
import { isClassKind, type Sections } from "../core/query/outline.js";

/** Structural subset of OutlineResult the renderer reads. */
export interface SkeletonInput {
  fqn: string;
  coordinates: string;
  provenance: Provenance;
  stale?: boolean;
  rows: Declaration[];
  imports?: string[];
}

/** Indentation step per nesting level, in spaces. */
const INDENT = 4;

/** Hard cap for a javadoc summary's visible characters; a cut appends `…` (181 total). */
const SUMMARY_MAX = 180;

/**
 * First-sentence javadoc summary: delimiters and per-line `*` decorations
 * stripped, lines joined with single spaces, text after the first block tag
 * (`@param`, `@return`, …) dropped, cut after the first sentence's period
 * (whole text when there is none), capped at SUMMARY_MAX chars with an
 * ellipsis. Inline `{@link …}` survives as plain text.
 */
export function summarizeJavadoc(raw: string): string {
  let body = raw.replace(/\*\/\s*$/, "");
  if (body.startsWith("/**")) body = body.slice(3);
  else if (body.startsWith("/*")) body = body.slice(2);
  const words: string[] = [];
  for (const line of body.split("\n")) {
    const text = line.replace(/^\s*\*? ?/, "").trim();
    if (text.startsWith("@")) break; // the block-tag section begins
    if (text.length > 0) words.push(text);
  }
  const joined = words.join(" ");
  const period = joined.indexOf(".");
  const sentence = period === -1 ? joined : joined.slice(0, period + 1);
  return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX)}…` : sentence;
}

/** A class row with its contents: members and nested class nodes, in first-occurrence row order. */
interface ClassNode {
  /** The class-kind row; undefined only for a root whose class row was filtered away. */
  row: Declaration | undefined;
  content: Array<Declaration | ClassNode>;
}

/**
 * Group rows into the nesting tree: rows with the target fqn belong to the
 * root; every other class-kind row opens a nested node AT ITS FIRST
 * OCCURRENCE, and deeper nodes attach under their declaring class.
 */
function buildTree(input: SkeletonInput): ClassNode {
  const root: ClassNode = { row: undefined, content: [] };
  const nodesByFqn = new Map<string, ClassNode>();
  for (const row of input.rows) {
    if (isClassKind(row.kind)) {
      if (row.fqn === input.fqn) {
        if (root.row === undefined) root.row = row;
        continue;
      }
      const node: ClassNode = { row, content: [] };
      nodesByFqn.set(row.fqn, node);
      const parentFqn = row.fqn.slice(0, row.fqn.lastIndexOf("."));
      (nodesByFqn.get(parentFqn) ?? root).content.push(node);
      continue;
    }
    (nodesByFqn.get(row.fqn) ?? root).content.push(row);
  }
  return root;
}

/** `signature;` — or ` { … }` for methods and constructors at full detail. */
function memberLine(row: Declaration, detail: "summary" | "full"): string {
  if (detail === "full" && (row.kind === "method" || row.kind === "constructor")) {
    return `${row.signature} { … }`;
  }
  return `${row.signature};`;
}

/** Javadoc lines for one row at `level`, per the detail mode. */
function javadocLines(row: Declaration, level: number, sections: Sections, detail: "summary" | "full"): string[] {
  if (!sections.javadoc || row.javadoc === undefined) return [];
  if (detail === "summary") {
    const summary = summarizeJavadoc(row.javadoc);
    return summary.length > 0 ? [`${indent(level)}/** ${summary} */`] : [];
  }
  return row.javadoc.split("\n").map((line) => {
    const text = line.trimStart();
    return text.startsWith("*") ? `${indent(level)} ${text}` : `${indent(level)}${text}`;
  });
}

function indent(level: number): string {
  return " ".repeat(level * INDENT);
}

/** Render one node: javadoc, signature + `{`, contents one level deeper, `}`. */
function renderNode(
  node: ClassNode,
  level: number,
  sections: Sections,
  detail: "summary" | "full",
  out: string[],
): void {
  const inner = node.row === undefined ? level : level + 1;
  if (node.row !== undefined) {
    out.push(...javadocLines(node.row, level, sections, detail));
    out.push(`${indent(level)}${node.row.signature} {`);
  }
  for (const item of node.content) {
    if ("content" in item) {
      renderNode(item, inner, sections, detail, out);
    } else {
      out.push(...javadocLines(item, inner, sections, detail));
      out.push(`${indent(inner)}${memberLine(item, detail)}`);
    }
  }
  if (node.row !== undefined) out.push(`${indent(level)}}`);
}

/**
 * Render the skeleton: `//` metadata header, package line (dotless fqns have
 * none), verbatim imports when present, then the class body with members as
 * signature lines at nesting-level indentation. Never truncates a line.
 */
export function renderSkeleton(
  input: SkeletonInput,
  sections: Sections,
  detail: "summary" | "full",
): string {
  const out: string[] = [
    `// ${input.fqn}`,
    `// ${input.coordinates}  provenance ${input.provenance}`,
    ...(input.stale ? ["// stale index served"] : []),
    "",
  ];
  const head: string[] = [];
  if (input.fqn.includes(".")) {
    head.push(`package ${input.fqn.slice(0, input.fqn.lastIndexOf("."))};`);
  }
  if (input.imports !== undefined) head.push(...input.imports);
  if (head.length > 0) out.push(...head, "");
  renderNode(buildTree(input), 0, sections, detail, out);
  return out.join("\n");
}
