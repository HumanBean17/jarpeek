import { describe, it, expect } from "vitest";
import { openContext } from "../../src/core/query/context.js";
import { ListingService } from "../../src/core/listing.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");

function tempProjectRoot(): string {
  const dir = join(tmpdir(), `jarpeek-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("QueryContext listings and decompiler", () => {

  it("provides a ListingService instance on context", () => {
    const tempDir = tempProjectRoot();
    try {
      const ctx = openContext(tempDir);
      expect(ctx.listings).toBeInstanceOf(ListingService);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("memoizes listing results: calling listing() twice returns the same cached object", async () => {
    const tempDir = tempProjectRoot();
    try {
      const ctx = openContext(tempDir);
      const artifact = {
        coordinates: "com.example:demo-lib:1.0.0",
        kind: "external" as const,
        binaryJar: DEMO_JAR,
      };

      const listing1 = await ctx.listings.listing(artifact);
      const listing2 = await ctx.listings.listing(artifact);

      // Same object identity = cached
      expect(listing1).toBe(listing2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("provides a decompiler function on context", () => {
    const tempDir = tempProjectRoot();
    try {
      const ctx = openContext(tempDir);
      expect(typeof ctx.decompiler).toBe("function");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
