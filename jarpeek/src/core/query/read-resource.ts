/**
 * readResource: the non-class half of a jar — config files, service
 * descriptors, manifests, anything that ships next to the code. Entries come
 * from the artifact's binary jar (the runtime truth) with the sources jar as
 * fallback. Text is served (truncated at 512KB); binaries are declined by
 * extension or a NUL sniff so an agent never burns context on class files
 * and images it cannot read.
 */
import { existsSync } from "node:fs";
import type { DependencyArtifact, Provenance } from "../types.js";
import { listZipEntries, readZipEntry } from "../../parse/zip.js";
import type { QueryContext } from "./context.js";

export interface ResourceEntry {
  path: string;
  size?: number;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
  note?: string;
}

export interface ReadResourceResult {
  artifact: string;
  entries: ResourceEntry[];
  provenance: Provenance;
}

/** Extensions that never have readable text content. */
const BINARY_EXTENSIONS = new Set([
  ".class",
  ".png",
  ".gif",
  ".jpg",
  ".jar",
  ".so",
  ".dylib",
  ".dll",
  ".kotlin_module",
  ".kotlin_builtins",
]);
const TEXT_LIMIT_BYTES = 512 * 1024;
const NUL_SNIFF_BYTES = 8 * 1024;
const BINARY_NOTE = "binary entry — content omitted";
const TRUNCATION_NOTE = `truncated at ${TEXT_LIMIT_BYTES} bytes`;

/**
 * glob-lite → anchored RegExp: `*` stays inside one path segment, `**`
 * crosses them, everything else (including `.` and `?`) is literal. The
 * pattern must match the full entry name.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else {
      pattern += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Resolve an artifact query against the manifest: exact coordinates, else a
 * unique artifact-id match (the segment between the first and second `:` —
 * `demo-lib` for `com.example:demo-lib:1.0.0`). Zero matches and ambiguous
 * matches both throw; ambiguity lists the candidates.
 */
export async function resolveArtifactQuery(
  ctx: QueryContext,
  query: string,
): Promise<DependencyArtifact> {
  const artifacts = await ctx.artifacts();
  const exact = artifacts.find((artifact) => artifact.coordinates === query);
  if (exact !== undefined) return exact;

  const matches = artifacts.filter((artifact) => artifact.coordinates.split(":")[1] === query);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous artifact "${query}": matches ${matches.map((m) => m.coordinates).join(", ")}`,
    );
  }
  throw new Error(`unknown artifact "${query}": not in the resolved set (${artifacts.length} artifacts)`);
}

function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * First `limit` bytes of `buf` as text, cut at a UTF-8 codepoint boundary: a
 * raw byte cut can split a multi-byte character and end the content on a
 * replacement character. Exported for tests.
 */
export function truncateUtf8(buf: Buffer, limit: number): string {
  let end = Math.min(limit, buf.length);
  // 0b10xxxxxx are continuation bytes — back off until `end` starts a character
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8");
}

function entry(path: string, buf: Buffer): ResourceEntry {
  const size = buf.length;
  if (isBinaryPath(path) || buf.subarray(0, NUL_SNIFF_BYTES).includes(0)) {
    return { path, size, binary: true, note: BINARY_NOTE };
  }
  if (buf.length > TEXT_LIMIT_BYTES) {
    return {
      path,
      size,
      content: truncateUtf8(buf, TEXT_LIMIT_BYTES),
      truncated: true,
      note: TRUNCATION_NOTE,
    };
  }
  return { path, size, content: buf.toString("utf8") };
}

/**
 * Read the entries of one artifact's jar matching `entryGlob`. An empty
 * `entries` list means the glob matched nothing; unknown or ambiguous
 * artifact queries throw.
 */
export async function readResource(
  ctx: QueryContext,
  artifactQuery: string,
  entryGlob: string,
): Promise<ReadResourceResult> {
  await ctx.ensureReady();
  const artifact = await resolveArtifactQuery(ctx, artifactQuery);
  const jar = artifact.binaryJar ?? artifact.sourcesJar;
  if (jar === undefined || !existsSync(jar)) {
    throw new Error(`${artifact.coordinates} has no readable jar (no binaryJar or sourcesJar on disk)`);
  }

  const pattern = globToRegExp(entryGlob);
  const entries: ResourceEntry[] = [];
  for (const zipEntry of await listZipEntries(jar)) {
    if (zipEntry.isDirectory || !pattern.test(zipEntry.name)) continue;
    // the entry is served from the artifact's runtime jar; size honors the
    // declared uncompressed length even when the buffer was truncated
    if (isBinaryPath(zipEntry.name)) {
      entries.push({
        path: zipEntry.name,
        size: zipEntry.uncompressedSize,
        binary: true,
        note: BINARY_NOTE,
      });
      continue;
    }
    entries.push(entry(zipEntry.name, await readZipEntry(jar, zipEntry)));
  }
  return { artifact: artifact.coordinates, entries, provenance: artifact.provenance };
}
