/**
 * Human-mode rendering: plain-text tables and numbered source lines.
 *
 * The renderer is deliberately dependency-free — column widths are the max
 * cell width capped at 60 chars, data cells are padded so columns align and
 * joined by two-space gutters, and whole rows are truncated at 120 chars.
 * `--json` output is a different, lossless path (json.ts); everything here
 * is for humans.
 */

/** Max chars a single cell contributes to its column width. */
const CELL_MAX = 60;
/** Two-space gutters between columns. */
const GUTTER = "  ";
/** Whole-row truncation limit. */
const ROW_MAX = 120;

/** Truncate with an ellipsis so the result never exceeds `max` chars. */
const clip = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;

/** Render rows as an aligned table; the first row is the header line. */
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const widths: number[] = [];
  for (let col = 0; col < columns; col++) {
    widths[col] = Math.min(
      CELL_MAX,
      Math.max(1, ...rows.map((row) => (row[col] ?? "").length)),
    );
  }
  return rows
    .map((row) =>
      row
        .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!)))
        .join(GUTTER),
    )
    .map((line) => clip(line, ROW_MAX))
    .join("\n");
}

/**
 * Prefix each line with its original number: `NNN│ `. Line numbers are
 * right-aligned to the widest number so the text column stays flush.
 */
export function numberLines(lines: string[], start = 1): string[] {
  const width = String(start + Math.max(lines.length - 1, 0)).length;
  return lines.map((line, index) => `${String(start + index).padStart(width)}│ ${line}`);
}

/** Uniform truncation for tabular cell values (single-line strings). */
export const clipCell = (text: string): string => clip(text, CELL_MAX);
