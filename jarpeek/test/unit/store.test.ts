import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { IndexStore } from "../../src/index/store.js";
import type { Declaration, DependencyArtifact } from "../../src/core/types.js";

function tmpCacheRoot(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-store-"));
}

function classRecord(fqn: string, selector: string): Declaration {
  return {
    fqn,
    file: `${fqn.replace(/\./g, "/")}.java`,
    selector,
    kind: "class",
    visibility: "public",
    static: false,
    deprecated: false,
    signature: `public class ${selector}`,
  };
}

function methodRecord(fqn: string, selector: string): Declaration {
  return {
    fqn,
    file: `${fqn.replace(/\./g, "/")}.java`,
    selector,
    kind: "method",
    visibility: "public",
    static: false,
    deprecated: false,
    signature: `public void ${selector}()`,
    lineStart: 7,
  };
}

function artifact(coordinates: string): DependencyArtifact {
  return {
    coordinates,
    kind: "external",
    provenance: "source",
    warnings: [],
  };
}

function readRawLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
}

describe("IndexStore", () => {
  it("writeArtifact + lookup returns one entry with meta and all records", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      const records = [
        classRecord("com.x.A", "A"),
        methodRecord("com.x.A", "alpha"),
        methodRecord("com.x.A", "beta"),
      ];
      await store.writeArtifact(artifact("g:a:1"), records);

      const hits = await store.lookup("com.x.A");
      expect(hits).toHaveLength(1);
      expect(hits[0].safe).toBe(encodeURIComponent("g:a:1"));
      expect(hits[0].meta.coordinates).toBe("g:a:1");
      expect(hits[0].records).toHaveLength(3);
      expect(hits[0].records.map((r) => r.selector).sort()).toEqual(["A", "alpha", "beta"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collision on the same fqn returns entries in write order; fqnCount stays 1", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await store.writeArtifact(artifact("g:a:1"), [classRecord("com.x.A", "A")]);
      await store.writeArtifact(artifact("g:b:1"), [
        classRecord("com.x.A", "A"),
        methodRecord("com.x.A", "only"),
      ]);

      const hits = await store.lookup("com.x.A");
      expect(hits).toHaveLength(2);
      expect(hits.map((h) => h.meta.coordinates)).toEqual(["g:a:1", "g:b:1"]);
      expect(hits[1].records).toHaveLength(2);

      const stats = await store.stats();
      expect(stats.fqnCount).toBe(1);
      expect(stats.artifactCount).toBe(2);
      expect(stats.cacheRoot).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists across instances on the same cacheRoot", async () => {
    const root = tmpCacheRoot();
    try {
      const first = new IndexStore(root);
      await first.writeArtifact(artifact("g:a:1"), [classRecord("com.x.A", "A")]);
      await first.writeArtifact(artifact("g:b:1"), [classRecord("com.x.A", "A")]);

      const second = new IndexStore(root);
      const hits = await second.lookup("com.x.A");
      expect(hits).toHaveLength(2);
      expect((await second.stats()).artifactCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("10 concurrent writeArtifact calls all land with every line valid JSON", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.writeArtifact(artifact(`g:art${i}:1`), [
            classRecord(`com.x.C${i}`, `C${i}`),
            methodRecord(`com.x.C${i}`, `run`),
          ]),
        ),
      );

      const stats = await store.stats();
      expect(stats.artifactCount).toBe(10);
      expect(stats.fqnCount).toBe(10);

      const shardsDir = join(root, "v1", "artifacts");
      for (const safe of readdirSync(shardsDir)) {
        const lines = readRawLines(join(shardsDir, safe, "records.ndjson"));
        expect(lines.length).toBe(2);
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lookup loads shards lazily into an LRU-bounded cache", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await store.writeArtifact(artifact("g:a:1"), [classRecord("com.x.A", "A")]);
      await store.writeArtifact(artifact("g:b:1"), [classRecord("com.x.B", "B")]);
      expect(store.loadedShardCount).toBe(0);

      await store.lookup("com.x.A");
      expect(store.loadedShardCount).toBe(1);
      await store.lookup("com.x.B");
      expect(store.loadedShardCount).toBe(2);

      // Capacity bound: 70 distinct artifacts force eviction back to 64.
      for (let i = 0; i < 70; i++) {
        await store.writeArtifact(artifact(`g:bulk${i}:1`), [classRecord(`com.bulk.C${i}`, `C${i}`)]);
      }
      for (let i = 0; i < 70; i++) {
        await store.lookup(`com.bulk.C${i}`);
      }
      expect(store.loadedShardCount).toBeLessThanOrEqual(64);
      expect(store.loadedShardCount).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readDirectory reflects an external directory.json mutation", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await store.writeArtifact(artifact("g:a:1"), [classRecord("com.x.A", "A")]);
      const before = await store.readDirectory();
      expect(before.has("com.x.A")).toBe(true);

      const dirPath = join(root, "v1", "directory.json");
      const parsed = JSON.parse(readFileSync(dirPath, "utf8"));
      parsed.fqns["com.external.Z"] = [encodeURIComponent("g:zzz:1")];
      writeFileSync(dirPath, JSON.stringify(parsed));
      // Ensure the mtime differs from the cached load.
      const future = new Date(Date.now() + 5000);
      utimesSync(dirPath, future, future);

      const after = await store.readDirectory();
      expect(after.has("com.external.Z")).toBe(true);
      expect(after.get("com.external.Z")).toEqual([encodeURIComponent("g:zzz:1")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips corrupt lines without throwing and flags a warning", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await store.writeArtifact(artifact("g:a:1"), [
        classRecord("com.x.A", "A"),
        methodRecord("com.x.A", "ok"),
      ]);

      const shardPath = join(root, "v1", "artifacts", encodeURIComponent("g:a:1"), "records.ndjson");
      writeFileSync(shardPath, `${readFileSync(shardPath, "utf8")}this is not json\n`);

      const hits = await store.lookup("com.x.A");
      expect(hits).toHaveLength(1);
      expect(hits[0].records).toHaveLength(2);
      expect(hits[0].meta.warnings).toContain("corrupt record in shard");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forEachRecord visits every record from every artifact", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await store.writeArtifact(artifact("g:a:1"), [
        classRecord("com.x.A", "A"),
        methodRecord("com.x.A", "alpha"),
        methodRecord("com.x.A", "beta"),
      ]);
      await store.writeArtifact(artifact("g:b:1"), [
        classRecord("com.x.B", "B"),
        methodRecord("com.x.B", "gamma"),
      ]);

      const seen = new Map<string, number>();
      let total = 0;
      await store.forEachRecord((rec, safe) => {
        total += 1;
        seen.set(safe, (seen.get(safe) ?? 0) + 1);
        expect(rec.fqn).toMatch(/^com\.x\.[AB]$/);
      });

      expect(total).toBe(5);
      expect(seen.get(encodeURIComponent("g:a:1"))).toBe(3);
      expect(seen.get(encodeURIComponent("g:b:1"))).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removeArtifact deletes the shard and its directory entries", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      await store.writeArtifact(artifact("g:a:1"), [classRecord("com.x.A", "A")]);
      await store.writeArtifact(artifact("g:b:1"), [classRecord("com.x.A", "A")]);

      await store.removeArtifact(encodeURIComponent("g:a:1"));

      const hits = await store.lookup("com.x.A");
      expect(hits.map((h) => h.meta.coordinates)).toEqual(["g:b:1"]);
      const stats = await store.stats();
      expect(stats.artifactCount).toBe(1);
      expect(readdirSync(join(root, "v1", "artifacts"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lookup racing a same-shard writeArtifact returns the new records, not stale cache", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      // A multi-chunk shard: 20k records (~2.5MB) force the loader's stream
      // across many macrotasks, so the write can land mid-parse — the exact
      // interleaving the generation guard exists for. A 3-record shard would
      // drain within one macrotask and never expose the race.
      const bigOld = [
        classRecord("com.race.A", "A"),
        ...Array.from({ length: 20_000 }, (_, i) => methodRecord("com.race.A", `old${i}`)),
      ];
      await store.writeArtifact(artifact("g:race:1"), bigOld);

      const racedLookup = store.lookup("com.race.A");
      // Hold the write back until the loader is provably mid-stream: poll
      // until the lookup has been running for a beat without finishing.
      const start = Date.now();
      while (Date.now() - start < 10) {
        await sleep(1);
      }
      await store.writeArtifact(artifact("g:race:1"), [
        classRecord("com.race.A", "A"),
        methodRecord("com.race.A", "new1"),
        methodRecord("com.race.A", "new2"),
      ]);
      const hits = await racedLookup;

      // The racing caller must see post-write content...
      expect(hits).toHaveLength(1);
      expect(hits[0].records.map((r) => r.selector).sort()).toEqual(["A", "new1", "new2"]);
      // ...and every later lookup must too: the LRU holds the new shard only.
      const after = await store.lookup("com.race.A");
      expect(after[0].records.map((r) => r.selector).sort()).toEqual(["A", "new1", "new2"]);
      expect(store.loadedShardCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lookup racing a same-shard removeArtifact does not cache the removed shard", async () => {
    const root = tmpCacheRoot();
    try {
      const store = new IndexStore(root);
      const big = [
        classRecord("com.race.A", "A"),
        ...Array.from({ length: 20_000 }, (_, i) => methodRecord("com.race.A", `m${i}`)),
      ];
      await store.writeArtifact(artifact("g:race:1"), big);
      await store.writeArtifact(artifact("g:race:2"), [classRecord("com.race.A", "A")]);

      const racedLookup = store.lookup("com.race.A");
      const start = Date.now();
      while (Date.now() - start < 10) {
        await sleep(1);
      }
      await store.removeArtifact(encodeURIComponent("g:race:1"));
      const hits = await racedLookup;

      expect(hits.map((h) => h.meta.coordinates).sort()).toEqual(["g:race:2"]);
      expect(store.loadedShardCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
