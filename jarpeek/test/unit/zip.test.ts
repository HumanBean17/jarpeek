import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EntryTooLargeError,
  Zip64UnsupportedError,
  ZipError,
  listZipEntries,
  readTextEntry,
  readZipEntry,
} from "../../src/parse/zip.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function u64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

interface CraftedZip {
  bytes: Buffer;
}

/**
 * Assemble a minimal single-entry stored zip by hand. `zip64` hides the
 * real sizes and local-header offset behind sentinel values plus a zip64
 * EOCD/locator pair; `omitLocator` keeps the sentinels but drops the
 * locator, and `comment` exercises the EOCD backwards scan. Corruption
 * knobs: `zip64ExtraBytes` truncates the extra field mid-payload and
 * `declaredCompressedSize` makes it advertise a size the file cannot back.
 */
function craftStoredZip(opts: {
  name: string;
  payload: Buffer;
  zip64?: boolean;
  omitLocator?: boolean;
  comment?: string;
  zip64ExtraBytes?: number;
  declaredCompressedSize?: number;
}): CraftedZip {
  const name = Buffer.from(opts.name, "utf8");
  const size = opts.payload.length;
  const crc = 0; // the reader does not verify crc32; a fixed value keeps this minimal

  const lfh = Buffer.concat([
    u32(LFH_SIG),
    u16(20), // version needed
    u16(0), // flags
    u16(0), // method: stored
    u16(0), // time
    u16(0), // date
    u32(crc),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0), // extra length
    name,
  ]);

  // the single entry's local header is the very first structure in the archive
  const localHeaderOffset = 0;
  const fullZip64Extra = Buffer.concat([
    u16(0x0001),
    u16(24),
    u64(size),
    u64(opts.declaredCompressedSize ?? size),
    u64(localHeaderOffset),
  ]);
  const zip64Extra = opts.zip64
    ? fullZip64Extra.subarray(0, opts.zip64ExtraBytes ?? fullZip64Extra.length)
    : Buffer.alloc(0);
  const cdh = Buffer.concat([
    u32(CDH_SIG),
    u16(20), // version made by
    u16(20), // version needed
    u16(0), // flags
    u16(0), // method: stored
    u16(0), // time
    u16(0), // date
    u32(crc),
    u32(opts.zip64 ? 0xffffffff : size),
    u32(opts.zip64 ? 0xffffffff : size),
    u16(name.length),
    u16(zip64Extra.length),
    u16(0), // comment length
    u16(0), // disk number start
    u16(0), // internal attributes
    u32(0), // external attributes
    u32(opts.zip64 ? 0xffffffff : localHeaderOffset),
    name,
    zip64Extra,
  ]);

  const cdOffset = lfh.length + size;
  const zip64EocdOffset = cdOffset + cdh.length;
  const zip64Eocd = Buffer.concat([
    u32(ZIP64_EOCD_SIG),
    u64(44), // size of record after this field
    u16(45), // version made by (4.5)
    u16(45), // version needed (4.5)
    u32(0), // this disk
    u32(0), // disk with central directory
    u64(1), // entries on this disk
    u64(1), // total entries
    u64(cdh.length),
    u64(cdOffset),
  ]);
  const locator = Buffer.concat([
    u32(ZIP64_LOCATOR_SIG),
    u32(0), // disk with zip64 EOCD
    u64(zip64EocdOffset),
    u32(1), // total disks
  ]);
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0), // this disk
    u16(0), // disk with central directory
    u16(opts.zip64 ? 0xffff : 1), // entries on this disk
    u16(opts.zip64 ? 0xffff : 1), // total entries
    u32(opts.zip64 ? 0xffffffff : cdh.length),
    u32(opts.zip64 ? 0xffffffff : cdOffset),
    u16(comment.length),
    comment,
  ]);

  const bytes = opts.zip64 && !opts.omitLocator
    ? Buffer.concat([lfh, opts.payload, cdh, zip64Eocd, locator, eocd])
    : Buffer.concat([lfh, opts.payload, cdh, eocd]);
  return { bytes };
}

async function writeTmpFile(bytes: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-zip-"));
  const path = join(dir, "crafted.zip");
  writeFileSync(path, bytes);
  return path;
}

function findEntry(names: { name: string }[], name: string) {
  const entry = names.find((e) => e.name === name);
  expect(entry, `entry ${name} should be listed`).toBeDefined();
  return entry!;
}

describe("listZipEntries", () => {
  it("lists classes, manifest, services, and resources with /-separated names", async () => {
    const entries = await listZipEntries(DEMO_JAR);
    const names = entries.map((e) => e.name);
    for (const expected of [
      "com/example/Demo.class",
      "META-INF/MANIFEST.MF",
      "META-INF/services/com.example.Demo",
      "config/app.properties",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).toContain("logo.png");
    for (const entry of entries) {
      expect(entry.name.includes("\\")).toBe(false);
      expect(entry.method).toBeGreaterThanOrEqual(0);
      expect(entry.compressedSize).toBeGreaterThanOrEqual(0);
      expect(entry.uncompressedSize).toBeGreaterThanOrEqual(0);
      expect(entry.localHeaderOffset).toBeGreaterThanOrEqual(0);
      expect(entry.isDirectory).toBe(entry.name.endsWith("/"));
    }
    const demoClass = findEntry(entries, "com/example/Demo.class");
    expect(demoClass.method).toBe(8); // jar tool deflates class files
    expect(demoClass.uncompressedSize).toBeGreaterThan(0);
    expect(demoClass.crc32).not.toBe(0);
    const directories = entries.filter((e) => e.isDirectory);
    expect(directories.length).toBeGreaterThan(0);
    expect(directories.every((d) => d.name.endsWith("/"))).toBe(true);
  });

  it("rejects a file that is not a zip with ZipError", async () => {
    const path = await writeTmpFile(Buffer.alloc(100));
    try {
      await expect(listZipEntries(path)).rejects.toBeInstanceOf(ZipError);
      await expect(listZipEntries(path)).rejects.toMatchObject({ name: "ZipError" });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("round-trips a hand-crafted stored zip with an EOCD comment", async () => {
    const payload = Buffer.from([0x01, 0x00, 0x02, 0xff, 0xfe, 0x00, 0x41]);
    const { bytes } = craftStoredZip({
      name: "stored/raw.bin",
      payload,
      comment: "jarpeek crafted EOCD comment",
    });
    const path = await writeTmpFile(bytes);
    try {
      const entries = await listZipEntries(path);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("stored/raw.bin");
      expect(entries[0].method).toBe(0);
      expect(entries[0].compressedSize).toBe(payload.length);
      expect(entries[0].uncompressedSize).toBe(payload.length);
      expect(Buffer.compare(await readZipEntry(path, entries[0]), payload)).toBe(0);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("resolves counts, sizes, and offsets through zip64 records", async () => {
    const payload = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x00, 0x10]);
    const { bytes } = craftStoredZip({ name: "zip64/stored.bin", payload, zip64: true });
    const path = await writeTmpFile(bytes);
    try {
      const entries = await listZipEntries(path);
      expect(entries).toHaveLength(1); // real count came from the zip64 EOCD, not the 0xffff sentinel
      const entry = entries[0];
      expect(entry.name).toBe("zip64/stored.bin");
      expect(entry.uncompressedSize).toBe(payload.length); // from the zip64 extra field
      expect(entry.compressedSize).toBe(payload.length); // from the zip64 extra field
      expect(entry.localHeaderOffset).toBe(0); // from the zip64 extra field
      expect(Buffer.compare(await readZipEntry(path, entry), payload)).toBe(0);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("throws Zip64UnsupportedError when sentinels lack a zip64 locator", async () => {
    const { bytes } = craftStoredZip({
      name: "broken/binary.bin",
      payload: Buffer.from([0x00, 0x01, 0x02]),
      zip64: true,
      omitLocator: true,
    });
    const path = await writeTmpFile(bytes);
    try {
      await expect(listZipEntries(path)).rejects.toBeInstanceOf(Zip64UnsupportedError);
      await expect(listZipEntries(path)).rejects.toBeInstanceOf(ZipError);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("throws ZipError for a zip64 extra field truncated mid-payload (not a raw RangeError)", async () => {
    // extra field carries the 0x0001 header plus only 4 of the 24 payload
    // bytes, so the first sentinel read runs past the central directory
    const { bytes } = craftStoredZip({
      name: "broken/extra.bin",
      payload: Buffer.from([0x00, 0x01]),
      zip64: true,
      zip64ExtraBytes: 8,
    });
    const path = await writeTmpFile(bytes);
    try {
      await expect(listZipEntries(path)).rejects.toBeInstanceOf(ZipError);
      await expect(listZipEntries(path)).rejects.toMatchObject({ name: "ZipError" });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

describe("readZipEntry", () => {
  it("round-trips the 8-byte binary fixture logo.png including its NUL byte", async () => {
    const entries = await listZipEntries(DEMO_JAR);
    const entry = findEntry(entries, "logo.png");
    const bytes = await readZipEntry(DEMO_JAR, entry);
    expect(bytes).toHaveLength(8);
    expect(bytes.includes(0)).toBe(true);
  });

  it("throws ZipError when the entry declares a compressed size past EOF (no huge allocation)", async () => {
    // 32 GiB declared in the zip64 extra field for a 3-byte payload: the
    // listing tolerates the lie, the read must refuse it before allocating
    const { bytes } = craftStoredZip({
      name: "liar/big.bin",
      payload: Buffer.from([0x00, 0x01, 0x02]),
      zip64: true,
      declaredCompressedSize: 0x800000000,
    });
    const path = await writeTmpFile(bytes);
    try {
      const entries = await listZipEntries(path);
      expect(entries[0].compressedSize).toBe(0x800000000);
      await expect(readZipEntry(path, entries[0])).rejects.toBeInstanceOf(ZipError);
      await expect(readZipEntry(path, entries[0])).rejects.toMatchObject({ name: "ZipError" });
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });
});

describe("readTextEntry", () => {
  it("returns the exact text of config/app.properties", async () => {
    const entries = await listZipEntries(DEMO_JAR);
    const entry = findEntry(entries, "config/app.properties");
    expect(await readTextEntry(DEMO_JAR, entry)).toBe("key=value");
  });

  it("throws EntryTooLargeError when the entry exceeds maxBytes", async () => {
    const entries = await listZipEntries(DEMO_JAR);
    const entry = findEntry(entries, "com/example/Demo.class");
    await expect(readTextEntry(DEMO_JAR, entry, 8)).rejects.toBeInstanceOf(EntryTooLargeError);
    await expect(readTextEntry(DEMO_JAR, entry, 8)).rejects.toBeInstanceOf(ZipError);
  });
});

const srcZip = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "lib", "src.zip") : undefined;
const srcZipIt = srcZip && existsSync(srcZip) ? it : it.skip;

describe("JDK src.zip (presence-gated)", () => {
  srcZipIt("reads a real large archive and a known source entry", async () => {
    const entries = await listZipEntries(srcZip!);
    expect(entries.length).toBeGreaterThan(10000);
    const stringJava = entries.find((e) => e.name.endsWith("String.java"));
    expect(stringJava).toBeDefined();
    const text = (await readTextEntry(srcZip!, stringJava!)).trimStart();
    expect(text.startsWith("/*") || text.startsWith("package")).toBe(true);
  });
});
