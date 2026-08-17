import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyArtifact } from "../../src/core/types.js";
import {
  computeDependencySetHash,
  isStale,
  readManifest,
  writeManifest,
  type Manifest,
} from "../../src/index/manifest.js";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function tmpProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-manifest-"));
}

function artifact(overrides: Partial<DependencyArtifact>): DependencyArtifact {
  return { coordinates: "g:a:1", kind: "external", provenance: "source", warnings: [], ...overrides };
}

function manifestFor(dependencySetHash: string, artifacts: DependencyArtifact[]): Manifest {
  return { version: 1, resolvedAt: new Date().toISOString(), dependencySetHash, artifacts };
}

function touchPlusOneSecond(path: string): void {
  const stats = statSync(path);
  const future = new Date(stats.mtimeMs + 1000);
  utimesSync(path, future, future);
}

describe("computeDependencySetHash", () => {
  it("empty project hashes the empty string", async () => {
    const root = tmpProjectRoot();
    try {
      expect(await computeDependencySetHash(root)).toBe(EMPTY_SHA256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is stable across calls and changes on a new submodule pom.xml and on an mtime touch", async () => {
    const root = tmpProjectRoot();
    try {
      const gradle = join(root, "build.gradle");
      writeFileSync(gradle, "plugins {}\n");
      writeFileSync(join(root, "settings.gradle"), "rootProject.name = 'demo'\n");

      const first = await computeDependencySetHash(root);
      const second = await computeDependencySetHash(root);
      expect(first).toBe(second);
      expect(first).not.toBe(EMPTY_SHA256);

      mkdirSync(join(root, "mod"));
      writeFileSync(join(root, "mod", "pom.xml"), "<project/>\n");
      const withPom = await computeDependencySetHash(root);
      expect(withPom).not.toBe(first);

      touchPlusOneSecond(gradle);
      expect(await computeDependencySetHash(root)).not.toBe(withPom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores pom.xml deeper than immediate subdirectories", async () => {
    const root = tmpProjectRoot();
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      writeFileSync(join(root, "a", "b", "pom.xml"), "<project/>\n");
      expect(await computeDependencySetHash(root)).toBe(EMPTY_SHA256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readManifest / writeManifest", () => {
  it("missing manifest reads as null", async () => {
    const root = tmpProjectRoot();
    try {
      expect(await readManifest(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips a manifest with no tmp files left behind", async () => {
    const root = tmpProjectRoot();
    try {
      const m: Manifest = manifestFor("deadbeef", [
        artifact({
          coordinates: "g:a:1.0",
          configuration: "compile",
          binaryJar: "/cache/a-1.0.jar",
          sourcesJar: "/cache/a-1.0-sources.jar",
          noDecompile: true,
          warnings: ["w"],
        }),
        artifact({ coordinates: ":mod", kind: "module", sourceDir: join(root, "mod"), warnings: [] }),
      ]);
      await writeManifest(root, m);

      expect(await readManifest(root)).toEqual(m);
      expect(readdirSync(join(root, ".jarpeek"))).toEqual(["manifest.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("corrupt manifest reads as null without throwing", async () => {
    const root = tmpProjectRoot();
    try {
      mkdirSync(join(root, ".jarpeek"));
      writeFileSync(join(root, ".jarpeek", "manifest.json"), "{not json");
      expect(await readManifest(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isStale", () => {
  it("fresh manifest is not stale; missing artifact jar or changed build file is", async () => {
    const root = tmpProjectRoot();
    try {
      const gradle = join(root, "build.gradle");
      writeFileSync(gradle, "plugins {}\n");
      const jar = join(root, "lib.jar");
      writeFileSync(jar, "fake jar");

      const hash = await computeDependencySetHash(root);
      await writeManifest(root, manifestFor(hash, [artifact({ binaryJar: jar })]));
      const m = (await readManifest(root)) as Manifest;
      expect(await isStale(root, m)).toBe(false);

      rmSync(jar);
      expect(await isStale(root, m)).toBe(true);

      writeFileSync(jar, "fake jar");
      writeFileSync(gradle, "plugins { id 'x' }\n");
      expect(await isStale(root, m)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags missing sourcesJar, sourceDir, and classesDir even when the hash matches", async () => {
    const root = tmpProjectRoot();
    try {
      const hash = await computeDependencySetHash(root);
      const allPresent: Manifest = manifestFor(hash, [
        artifact({ sourcesJar: join(root, "a-sources.jar"), warnings: [] }),
        artifact({ coordinates: ":mod", kind: "module", sourceDir: join(root, "mod"), warnings: [] }),
        artifact({ coordinates: ":cls", kind: "module", classesDir: join(root, "classes"), warnings: [] }),
      ]);
      mkdirSync(join(root, "mod"));
      mkdirSync(join(root, "classes"));
      writeFileSync(join(root, "a-sources.jar"), "jar");
      expect(await isStale(root, allPresent)).toBe(false);

      const anyMissing: Manifest = manifestFor(hash, [
        artifact({ sourcesJar: join(root, "gone-sources.jar") }),
        artifact({ coordinates: ":mod2", kind: "module", sourceDir: join(root, "gone-mod") }),
        artifact({ coordinates: ":cls2", kind: "module", classesDir: join(root, "gone-classes") }),
      ]);
      expect(await isStale(root, anyMissing)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
