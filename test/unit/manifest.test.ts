import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

/** The m2 root the hash tests fingerprint under. */
const M2 = "/home/dev/.m2/repository";

/** An empty project hashes just the m2Root + strategy lines. */
const EMPTY_SHA256 = createHash("sha256")
  .update([`m2Root\t${M2}`, "strategy\tauto"].sort().join("\n"))
  .digest("hex");

function tmpProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-manifest-"));
}

function artifact(overrides: Partial<DependencyArtifact>): DependencyArtifact {
  return { coordinates: "g:a:1", kind: "external", ...overrides };
}

function manifestFor(dependencySetHash: string, artifacts: DependencyArtifact[]): Manifest {
  return { version: 2, resolvedAt: new Date().toISOString(), dependencySetHash, artifacts };
}

function touchPlusOneSecond(path: string): void {
  const stats = statSync(path);
  const future = new Date(stats.mtimeMs + 1000);
  utimesSync(path, future, future);
}

describe("computeDependencySetHash", () => {
  it("empty project hashes just the strategy line (stable, distinguishable from null)", async () => {
    const root = tmpProjectRoot();
    try {
      expect(await computeDependencySetHash(root, "auto", M2)).toBe(EMPTY_SHA256);
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

      const first = await computeDependencySetHash(root, "auto", M2);
      const second = await computeDependencySetHash(root, "auto", M2);
      expect(first).toBe(second);
      expect(first).not.toBe(EMPTY_SHA256);

      mkdirSync(join(root, "mod"));
      writeFileSync(join(root, "mod", "pom.xml"), "<project/>\n");
      const withPom = await computeDependencySetHash(root, "auto", M2);
      expect(withPom).not.toBe(first);

      touchPlusOneSecond(gradle);
      expect(await computeDependencySetHash(root, "auto", M2)).not.toBe(withPom);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("changes on a new submodule build.gradle.kts (Gradle multi-module)", async () => {
    const root = tmpProjectRoot();
    try {
      const before = await computeDependencySetHash(root, "auto", M2);

      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, "sub", "build.gradle.kts"), "plugins { java }\n");
      const withSubmodule = await computeDependencySetHash(root, "auto", M2);
      expect(withSubmodule).not.toBe(before);

      touchPlusOneSecond(join(root, "sub", "build.gradle.kts"));
      expect(await computeDependencySetHash(root, "auto", M2)).not.toBe(withSubmodule);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores pom.xml deeper than immediate subdirectories", async () => {
    const root = tmpProjectRoot();
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      writeFileSync(join(root, "a", "b", "pom.xml"), "<project/>\n");
      expect(await computeDependencySetHash(root, "auto", M2)).toBe(EMPTY_SHA256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the strategy in the fingerprint: stable per value, different across values", async () => {
    const root = tmpProjectRoot();
    try {
      writeFileSync(join(root, "pom.xml"), "<project/>");

      const auto = await computeDependencySetHash(root, "auto", M2);
      expect(await computeDependencySetHash(root, "auto", M2)).toBe(auto);
      expect(await computeDependencySetHash(root, "wrapper", M2)).not.toBe(auto);
      expect(await computeDependencySetHash(root, "system", M2)).not.toBe(auto);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the effective m2 root: a root flip alone re-hashes", async () => {
    const root = tmpProjectRoot();
    try {
      writeFileSync(join(root, "pom.xml"), "<project/>");

      const here = await computeDependencySetHash(root, "auto", M2);
      expect(await computeDependencySetHash(root, "auto", M2)).toBe(here);
      expect(await computeDependencySetHash(root, "auto", "/relocated/m2")).not.toBe(here);
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
        }),
        artifact({ coordinates: ":mod", kind: "module", sourceDir: join(root, "mod") }),
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

  it("a v1-shaped manifest reads as null (layout bumps force a re-resolve)", async () => {
    const root = tmpProjectRoot();
    try {
      mkdirSync(join(root, ".jarpeek"));
      const v1 = {
        version: 1,
        resolvedAt: new Date().toISOString(),
        dependencySetHash: EMPTY_SHA256,
        artifacts: [
          {
            coordinates: "com.example:old:1",
            kind: "external",
            binaryJar: "/cache/old-1.jar",
            provenance: "source",
            warnings: [],
          },
        ],
      };
      writeFileSync(join(root, ".jarpeek", "manifest.json"), JSON.stringify(v1));
      expect(await readManifest(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the written JSON omits absent optional fields", async () => {
    const root = tmpProjectRoot();
    try {
      const jar = join(root, "lib.jar");
      writeFileSync(jar, "fake jar");
      await writeManifest(root, manifestFor("deadbeef", [artifact({ binaryJar: jar })]));

      const raw = JSON.parse(readFileSync(join(root, ".jarpeek", "manifest.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const artifacts = raw.artifacts as Array<Record<string, unknown>>;
      expect(artifacts[0]!.binaryJar).toBe(jar);
      expect(artifacts[0]!.sourcesJar).toBeUndefined();
      expect(artifacts[0]!.sourceDir).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isStale", () => {
  it("a strategy change alone flips staleness", async () => {
    const root = tmpProjectRoot();
    try {
      writeFileSync(join(root, "pom.xml"), "<project/>");
      const m = manifestFor(await computeDependencySetHash(root, "wrapper", M2), [artifact({})]);

      expect(await isStale(root, m, "auto", M2)).toBe(true);
      expect(await isStale(root, m, "wrapper", M2)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an m2 root change alone flips staleness", async () => {
    const root = tmpProjectRoot();
    try {
      writeFileSync(join(root, "pom.xml"), "<project/>");
      const m = manifestFor(await computeDependencySetHash(root, "auto", "/relocated/m2"), [artifact({})]);

      expect(await isStale(root, m, "auto", M2)).toBe(true);
      expect(await isStale(root, m, "auto", "/relocated/m2")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh manifest is not stale; missing artifact jar or changed build file is", async () => {
    const root = tmpProjectRoot();
    try {
      const gradle = join(root, "build.gradle");
      writeFileSync(gradle, "plugins {}\n");
      const jar = join(root, "lib.jar");
      writeFileSync(jar, "fake jar");

      const hash = await computeDependencySetHash(root, "auto", M2);
      await writeManifest(root, manifestFor(hash, [artifact({ binaryJar: jar })]));
      const m = (await readManifest(root)) as Manifest;
      expect(await isStale(root, m, "auto", M2)).toBe(false);

      rmSync(jar);
      expect(await isStale(root, m, "auto", M2)).toBe(true);

      writeFileSync(jar, "fake jar");
      writeFileSync(gradle, "plugins { id 'x' }\n");
      expect(await isStale(root, m, "auto", M2)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags missing sourcesJar and sourceDir even when the hash matches", async () => {
    const root = tmpProjectRoot();
    try {
      const hash = await computeDependencySetHash(root, "auto", M2);
      const allPresent: Manifest = manifestFor(hash, [
        artifact({ sourcesJar: join(root, "a-sources.jar") }),
        artifact({ coordinates: ":mod", kind: "module", sourceDir: join(root, "mod") }),
      ]);
      mkdirSync(join(root, "mod"));
      writeFileSync(join(root, "a-sources.jar"), "jar");
      expect(await isStale(root, allPresent, "auto", M2)).toBe(false);

      const anyMissing: Manifest = manifestFor(hash, [
        artifact({ sourcesJar: join(root, "gone-sources.jar") }),
        artifact({ coordinates: ":mod2", kind: "module", sourceDir: join(root, "gone-mod") }),
      ]);
      expect(await isStale(root, anyMissing, "auto", M2)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a module whose sources changed after resolving is NOT stale", async () => {
    // source-tree contents are not fingerprinted: a sibling-file edit
    // without a build-file move leaves the manifest fresh, because the
    // resolve-only manifest only promises WHICH artifacts back the project
    const root = tmpProjectRoot();
    try {
      const sourceDir = join(root, "src", "main", "java");
      mkdirSync(join(sourceDir, "com", "mod"), { recursive: true });
      writeFileSync(
        join(sourceDir, "com", "mod", "Thing.java"),
        "package com.mod;\n\npublic class Thing {\n  int x = 1;\n}\n",
      );
      const hash = await computeDependencySetHash(root, "auto", M2);
      const m: Manifest = manifestFor(hash, [
        artifact({ coordinates: ":app", kind: "module", sourceDir }),
      ]);
      expect(await isStale(root, m, "auto", M2)).toBe(false);

      const helper = join(sourceDir, "com", "mod", "Helper.kt");
      writeFileSync(helper, "package com.mod\n\nclass Helper(val extra: Int)\n");
      touchPlusOneSecond(helper);
      expect(await isStale(root, m, "auto", M2)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
