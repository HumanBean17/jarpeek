/**
 * Pure-TS zip reader: central-directory listing and entry extraction.
 *
 * All reads are positional on an open fd — the archive is never buffered in
 * full, so multi-hundred-megabyte zips cost one central-directory window.
 * Handles classic EOCD (backwards scan, zip comments up to 64 KiB), zip64
 * end-of-central-directory records when counts/offsets hit their 0xFFFF /
 * 0xFFFFFFFF sentinels, and zip64 extra fields carrying entry sizes and
 * local-header offsets. Every malformed input degrades to a named ZipError,
 * never a crash or hang.
 */
import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/** One central-directory record. Entry names are always `/`-separated. */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
  crc32: number;
  isDirectory: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** The archive announces zip64 records (sentinel values) but they are missing or malformed. */
export class Zip64UnsupportedError extends ZipError {
  constructor(message: string) {
    super(message);
    this.name = "Zip64UnsupportedError";
  }
}

/** The entry exceeds the caller's byte limit for text extraction. */
export class EntryTooLargeError extends ZipError {
  constructor(message: string) {
    super(message);
    this.name = "EntryTooLargeError";
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
const SENTINEL16 = 0xffff;
const SENTINEL32 = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;
const DEFAULT_TEXT_LIMIT_BYTES = 5 * 1024 * 1024;

/** Read exactly `length` bytes at `position`, tolerating short reads. */
async function readFull(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fh.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) {
      throw new ZipError(`unexpected end of file at byte ${position + read} (wanted ${length})`);
    }
    read += bytesRead;
  }
  return buffer;
}

function readSafeUint64(buffer: Buffer, offset: number, what: string): number {
  const value = Number(buffer.readBigUInt64LE(offset));
  if (!Number.isSafeInteger(value)) {
    throw new ZipError(`${what} exceeds the supported 2^53-byte range`);
  }
  return value;
}

/**
 * Scan backwards from EOF for the classic end-of-central-directory record.
 * A candidate only counts when its declared comment length reaches exactly
 * to the end of the file, so a signature-like byte sequence inside stored
 * data or a comment cannot win over the real record.
 */
async function findEocd(fh: FileHandle, fileSize: number): Promise<{ offset: number; record: Buffer }> {
  if (fileSize < EOCD_SIZE) {
    throw new ZipError(`file is only ${fileSize} bytes, too small to be a zip`);
  }
  const scanLength = Math.min(fileSize, EOCD_SIZE + MAX_COMMENT);
  const tail = await readFull(fh, scanLength, fileSize - scanLength);
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + EOCD_SIZE + commentLength !== tail.length) continue;
    return { offset: fileSize - scanLength + i, record: tail.subarray(i, i + EOCD_SIZE) };
  }
  throw new ZipError("end of central directory record not found (not a zip file?)");
}

/** Follow the zip64 locator to the zip64 EOCD for real counts, sizes, and offsets. */
async function resolveZip64(
  fh: FileHandle,
  eocdOffset: number,
): Promise<{ totalEntries: number; cdSize: number; cdOffset: number }> {
  if (eocdOffset < ZIP64_LOCATOR_SIZE) {
    throw new Zip64UnsupportedError("zip64 sentinels present but no room for a zip64 locator");
  }
  const locator = await readFull(fh, ZIP64_LOCATOR_SIZE, eocdOffset - ZIP64_LOCATOR_SIZE);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) {
    throw new Zip64UnsupportedError("zip64 sentinels present but zip64 locator signature is missing");
  }
  const zip64EocdOffset = readSafeUint64(locator, 8, "zip64 EOCD offset");
  const record = await readFull(fh, ZIP64_EOCD_SIZE, zip64EocdOffset);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
    throw new Zip64UnsupportedError(`zip64 EOCD signature mismatch at offset ${zip64EocdOffset}`);
  }
  return {
    totalEntries: readSafeUint64(record, 32, "zip64 entry count"),
    cdSize: readSafeUint64(record, 40, "zip64 central-directory size"),
    cdOffset: readSafeUint64(record, 48, "zip64 central-directory offset"),
  };
}

function parseCentralDirectory(cd: Buffer, expectedEntries: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;
  while (entries.length < expectedEntries) {
    if (pos + CENTRAL_HEADER_SIZE > cd.length) {
      throw new ZipError(
        `truncated central directory: expected ${expectedEntries} entries, parsed ${entries.length}`,
      );
    }
    if (cd.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new ZipError(`bad central-directory signature at entry ${entries.length}`);
    }
    const method = cd.readUInt16LE(pos + 10);
    const crc32 = cd.readUInt32LE(pos + 16);
    let compressedSize = cd.readUInt32LE(pos + 20);
    let uncompressedSize = cd.readUInt32LE(pos + 24);
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    let localHeaderOffset = cd.readUInt32LE(pos + 42);
    const nameStart = pos + CENTRAL_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    const extraEnd = extraStart + extraLength;
    const recordEnd = extraEnd + commentLength;
    if (recordEnd > cd.length) {
      throw new ZipError(`truncated central-directory entry ${entries.length}`);
    }
    const name = cd.toString("utf8", nameStart, extraStart).replace(/\\/g, "/");
    if (
      uncompressedSize === SENTINEL32 ||
      compressedSize === SENTINEL32 ||
      localHeaderOffset === SENTINEL32
    ) {
      // zip64 extended information: fields appear in fixed order, each only
      // when the fixed-size record carries its sentinel value
      let p = extraStart;
      while (p + 4 <= extraEnd) {
        const fieldId = cd.readUInt16LE(p);
        const fieldSize = cd.readUInt16LE(p + 2);
        if (fieldId === ZIP64_EXTRA_ID) {
          let q = p + 4;
          if (uncompressedSize === SENTINEL32) {
            uncompressedSize = readSafeUint64(cd, q, "zip64 uncompressed size");
            q += 8;
          }
          if (compressedSize === SENTINEL32) {
            compressedSize = readSafeUint64(cd, q, "zip64 compressed size");
            q += 8;
          }
          if (localHeaderOffset === SENTINEL32) {
            localHeaderOffset = readSafeUint64(cd, q, "zip64 local-header offset");
          }
          break;
        }
        p += 4 + fieldSize;
      }
    }
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method,
      localHeaderOffset,
      crc32,
      isDirectory: name.endsWith("/"),
    });
    pos = recordEnd;
  }
  return entries;
}

/** List every entry in the archive via its central directory. */
export async function listZipEntries(zipPath: string): Promise<ZipEntry[]> {
  const fh = await open(zipPath, "r");
  try {
    const { size } = await fh.stat();
    const { offset: eocdOffset, record: eocd } = await findEocd(fh, size);
    let totalEntries = eocd.readUInt16LE(10);
    let cdSize = eocd.readUInt32LE(12);
    let cdOffset = eocd.readUInt32LE(16);
    if (totalEntries === SENTINEL16 || cdSize === SENTINEL32 || cdOffset === SENTINEL32) {
      ({ totalEntries, cdSize, cdOffset } = await resolveZip64(fh, eocdOffset));
    }
    if (cdOffset + cdSize > size) {
      throw new ZipError(
        `central directory (${cdSize} bytes at ${cdOffset}) runs past the ${size}-byte file`,
      );
    }
    if (totalEntries * CENTRAL_HEADER_SIZE > cdSize) {
      throw new ZipError(`central directory claims ${totalEntries} entries in only ${cdSize} bytes`);
    }
    const cd = await readFull(fh, cdSize, cdOffset);
    return parseCentralDirectory(cd, totalEntries);
  } finally {
    await fh.close();
  }
}

/** Extract and decompress one entry (method 0 stored, method 8 deflate). */
export async function readZipEntry(zipPath: string, entry: ZipEntry): Promise<Buffer> {
  const fh = await open(zipPath, "r");
  try {
    const header = await readFull(fh, LOCAL_HEADER_SIZE, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIG) {
      throw new ZipError(`bad local-header signature for entry ${entry.name}`);
    }
    // the local header carries its own name/extra lengths, which may differ
    // from the central directory's (e.g. its own zip64 extra field)
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
    const raw = await readFull(fh, entry.compressedSize, dataOffset);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      try {
        return inflateRawSync(raw);
      } catch (cause) {
        throw new ZipError(`failed to inflate entry ${entry.name}: ${(cause as Error).message}`);
      }
    }
    throw new ZipError(`unsupported compression method ${entry.method} for entry ${entry.name}`);
  } finally {
    await fh.close();
  }
}

/** Extract one entry as utf8 text, refusing entries over `maxBytes` uncompressed. */
export async function readTextEntry(
  zipPath: string,
  entry: ZipEntry,
  maxBytes: number = DEFAULT_TEXT_LIMIT_BYTES,
): Promise<string> {
  if (entry.uncompressedSize > maxBytes) {
    throw new EntryTooLargeError(
      `entry ${entry.name} is ${entry.uncompressedSize} bytes uncompressed, over the ${maxBytes}-byte limit`,
    );
  }
  return (await readZipEntry(zipPath, entry)).toString("utf8");
}
