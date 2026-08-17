import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Declaration, DependencyArtifact } from "../core/types.js";
import { withLock } from "../util/lockfile.js";

/** On-disk layout version; bumps invalidate the whole `<cacheRoot>/v1` tree. */
const LAYOUT_VERSION = "v1";
/** Upper bound on parsed shards kept in memory; oldest loaded shard evicts first. */
const LRU_CAPACITY = 64;

interface DirectoryFile {
  version: 1;
  fqns: Record<string, string[]>;
}

interface ShardMeta extends DependencyArtifact {
  indexedAt: string;
}

interface LoadedShard {
  meta: ShardMeta;
  records: Declaration[];
}

/**
 * Persistent declaration index: artifact-sharded NDJSON plus a global
 * FQN → safes directory.
 *
 * Writers serialize through `withLock`; every mutation is tmp-file + rename
 * so readers only ever observe whole files. Readers take no lock — the MCP
 * process stays lock-free and picks up external writes via directory mtime.
 */
export class IndexStore {
  private readonly cacheRoot: string;
  private readonly shardLru = new Map<string, LoadedShard>();
  private directoryCache: Map<string, string[]> | undefined;
  private directoryMtimeMs: number | undefined;

  constructor(cacheRoot: string) {
    this.cacheRoot = cacheRoot;
  }

  /** Number of parsed shards currently held in the in-memory LRU. */
  get loadedShardCount(): number {
    return this.shardLru.size;
  }

  private get versionDir(): string {
    return join(this.cacheRoot, LAYOUT_VERSION);
  }

  private get artifactsDir(): string {
    return join(this.versionDir, "artifacts");
  }

  private get directoryPath(): string {
    return join(this.versionDir, "directory.json");
  }

  private shardDir(safe: string): string {
    return join(this.artifactsDir, safe);
  }

  /**
   * FQN → safes map from `directory.json`, memoized per instance.
   * Re-reads whenever the file's mtime differs from the last load so a
   * long-lived process observes external writes.
   */
  async readDirectory(): Promise<Map<string, string[]>> {
    const stats = this.statIfExists(this.directoryPath);
    if (this.directoryCache && stats && stats.mtimeMs === this.directoryMtimeMs) {
      return this.directoryCache;
    }
    const fqns = this.parseDirectoryFile();
    this.directoryCache = fqns;
    this.directoryMtimeMs = stats?.mtimeMs;
    return fqns;
  }

  /**
   * All shards declaring `fqn`, in write order. Shards parse lazily into a
   * capacity-64 LRU; corrupt lines are skipped and surfaced as a warning on
   * the returned meta — lookup never throws on a bad shard.
   */
  async lookup(fqn: string): Promise<Array<{ safe: string; meta: DependencyArtifact; records: Declaration[] }>> {
    const directory = await this.readDirectory();
    const safes = directory.get(fqn) ?? [];
    const results: Array<{ safe: string; meta: DependencyArtifact; records: Declaration[] }> = [];
    for (const safe of safes) {
      const shard = await this.loadShard(safe);
      if (shard) {
        results.push({ safe, meta: shard.meta, records: shard.records });
      }
    }
    return results;
  }

  /**
   * Persist one artifact's records under the writers lock: shard files and
   * directory.json each go through tmp + rename, and the directory gains the
   * artifact under every distinct fqn in `records`.
   */
  async writeArtifact(artifact: DependencyArtifact, records: Declaration[]): Promise<void> {
    await withLock(this.cacheRoot, async () => {
      const safe = safeName(artifact.coordinates);
      const shardDir = this.shardDir(safe);
      mkdirSync(shardDir, { recursive: true });

      const ndjson = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
      this.writeAtomically(join(shardDir, "records.ndjson"), ndjson);
      this.writeAtomically(
        join(shardDir, "meta.json"),
        JSON.stringify({ ...artifact, indexedAt: new Date().toISOString() } satisfies ShardMeta),
      );

      const directory = await this.readDirectoryUnlocked();
      for (const record of records) {
        const existing = directory.get(record.fqn) ?? [];
        if (!existing.includes(safe)) {
          existing.push(safe);
          directory.set(record.fqn, existing);
        }
      }
      this.writeDirectoryUnlocked(directory);

      this.shardLru.delete(safe);
    });
  }

  /** Drop an artifact's shard directory and every directory entry pointing at it. */
  async removeArtifact(safe: string): Promise<void> {
    await withLock(this.cacheRoot, async () => {
      rmSync(this.shardDir(safe), { recursive: true, force: true });
      const directory = await this.readDirectoryUnlocked();
      for (const [fqn, safes] of directory) {
        const kept = safes.filter((s) => s !== safe);
        if (kept.length === 0) {
          directory.delete(fqn);
        } else if (kept.length !== safes.length) {
          directory.set(fqn, kept);
        }
      }
      this.writeDirectoryUnlocked(directory);
      this.shardLru.delete(safe);
    });
  }

  /**
   * Stream every record of every shard to `fn`, artifacts in readdir order.
   * Reads shard files line-by-line and bypasses the LRU entirely.
   */
  async forEachRecord(fn: (rec: Declaration, safe: string) => void | Promise<void>): Promise<void> {
    if (!existsSync(this.artifactsDir)) {
      return;
    }
    for (const safe of readdirSync(this.artifactsDir)) {
      const shardPath = join(this.shardDir(safe), "records.ndjson");
      if (!this.statIfExists(shardPath)) {
        continue;
      }
      const reader = createInterface({ input: createReadStream(shardPath, "utf8"), crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          if (line.trim().length === 0) {
            continue;
          }
          const record = parseRecordLine(line);
          if (record) {
            await fn(record, safe);
          }
        }
      } finally {
        reader.close();
      }
    }
  }

  /** Directory + artifacts-dir counts; never touches shard files. */
  async stats(): Promise<{ artifactCount: number; fqnCount: number; cacheRoot: string }> {
    const directory = await this.readDirectory();
    const artifactCount = this.statIfExists(this.artifactsDir)
      ? readdirSync(this.artifactsDir).length
      : 0;
    return { artifactCount, fqnCount: directory.size, cacheRoot: this.cacheRoot };
  }

  /**
   * Read (or re-read) the directory while already holding the writers lock.
   * Returns a copy: callers mutate the map before writing it back.
   */
  private async readDirectoryUnlocked(): Promise<Map<string, string[]>> {
    const stats = this.statIfExists(this.directoryPath);
    if (this.directoryCache && stats && stats.mtimeMs === this.directoryMtimeMs) {
      return new Map(this.directoryCache);
    }
    const fqns = this.parseDirectoryFile();
    this.directoryCache = new Map(fqns);
    this.directoryMtimeMs = stats?.mtimeMs;
    return fqns;
  }

  private parseDirectoryFile(): Map<string, string[]> {
    const fqns = new Map<string, string[]>();
    if (!this.statIfExists(this.directoryPath)) {
      return fqns;
    }
    const parsed = this.parseJsonFile(this.directoryPath) as Partial<DirectoryFile> | undefined;
    if (parsed?.fqns && typeof parsed.fqns === "object") {
      for (const [fqn, safes] of Object.entries(parsed.fqns)) {
        if (Array.isArray(safes)) {
          fqns.set(fqn, safes.filter((s): s is string => typeof s === "string"));
        }
      }
    }
    return fqns;
  }

  private writeDirectoryUnlocked(directory: Map<string, string[]>): void {
    const fqns: Record<string, string[]> = {};
    for (const [fqn, safes] of directory) {
      fqns[fqn] = safes;
    }
    mkdirSync(this.versionDir, { recursive: true });
    this.writeAtomically(this.directoryPath, JSON.stringify({ version: 1, fqns } satisfies DirectoryFile));
    this.directoryMtimeMs = this.statIfExists(this.directoryPath)?.mtimeMs;
    this.directoryCache = new Map(directory);
  }

  /** Parse a shard into the LRU; missing shards return undefined. */
  private async loadShard(safe: string): Promise<LoadedShard | undefined> {
    const cached = this.shardLru.get(safe);
    if (cached) {
      // Re-insert so Map ordering tracks recency for the capacity trim.
      this.shardLru.delete(safe);
      this.shardLru.set(safe, cached);
      return cached;
    }
    const shardDir = this.shardDir(safe);
    const metaStats = this.statIfExists(join(shardDir, "meta.json"));
    const ndjsonStats = this.statIfExists(join(shardDir, "records.ndjson"));
    if (!metaStats || !ndjsonStats) {
      return undefined;
    }
    const parsedMeta = this.parseJsonFile(join(shardDir, "meta.json")) as
      | (Partial<ShardMeta> & Record<string, unknown>)
      | undefined;
    const meta: ShardMeta = {
      ...(parsedMeta as ShardMeta | undefined),
      coordinates: typeof parsedMeta?.coordinates === "string" ? parsedMeta.coordinates : safe,
      kind: parsedMeta?.kind ?? "cache-scan",
      provenance: parsedMeta?.provenance ?? "signature",
      warnings: Array.isArray(parsedMeta?.warnings) ? [...parsedMeta.warnings] : [],
      indexedAt: typeof parsedMeta?.indexedAt === "string" ? parsedMeta.indexedAt : new Date(0).toISOString(),
    };

    const records: Declaration[] = [];
    const reader = createInterface({
      input: createReadStream(join(shardDir, "records.ndjson"), "utf8"),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of reader) {
        if (line.trim().length === 0) {
          continue;
        }
        const record = parseRecordLine(line);
        if (record) {
          records.push(record);
        } else {
          meta.warnings.push("corrupt record in shard");
        }
      }
    } finally {
      reader.close();
    }

    const loaded: LoadedShard = { meta, records };
    this.shardLru.set(safe, loaded);
    while (this.shardLru.size > LRU_CAPACITY) {
      const oldest = this.shardLru.keys().next().value as string;
      this.shardLru.delete(oldest);
    }
    return loaded;
  }

  private writeAtomically(path: string, contents: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  }

  private statIfExists(path: string) {
    try {
      return statSync(path);
    } catch {
      return undefined;
    }
  }

  private parseJsonFile(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }
}

function safeName(coordinates: string): string {
  return encodeURIComponent(coordinates);
}

/** One NDJSON line → Declaration; blank/invalid lines yield undefined. */
function parseRecordLine(line: string): Declaration | undefined {
  try {
    const value = JSON.parse(line) as Partial<Declaration>;
    if (typeof value?.fqn !== "string" || typeof value?.selector !== "string" || typeof value?.kind !== "string") {
      return undefined;
    }
    return value as Declaration;
  } catch {
    return undefined;
  }
}
