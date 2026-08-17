/** Split text on `\n`, stripping any trailing `\r` (CRLF-safe). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const raw = text.split("\n");
  const last = raw[raw.length - 1];
  if (last === "") raw.pop();
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

export interface SliceResult {
  lines: string[];
  startLine: number;
  endLine: number;
  clamped: boolean;
}

/**
 * Extract a 1-based inclusive line range.
 *
 * Out-of-range bounds clamp to the file bounds and report `clamped: true`.
 * Empty text yields empty lines.
 */
export function sliceLines(text: string, from: number, to: number): SliceResult {
  const all = splitLines(text);
  const total = all.length;
  if (total === 0) {
    return { lines: [], startLine: from, endLine: to, clamped: true };
  }
  const clampedFrom = Math.max(1, from);
  const clampedTo = Math.min(total, to);
  const clamped = clampedFrom !== from || clampedTo !== to || clampedFrom > clampedTo;
  const startLine = clampedFrom;
  const endLine = Math.max(clampedFrom - 1, clampedTo);
  return {
    lines: all.slice(startLine - 1, endLine),
    startLine,
    endLine,
    clamped,
  };
}
