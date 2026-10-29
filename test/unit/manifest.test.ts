import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyArtifact } from "../../src/core/types.js";
import {
  buildFiles,
  computeDependencySetHash,
  isStale,
  lastManifestPath,
  manifestPath,
  readManifest,
  writeManifest,
  type Manifest,
} from "../../src/index/manifest.js";
import { withResolveLock } from "../../src/index/lock.js";
import { moduleNamespace } from "../../src/resolver/module-coordinate.js";

/** The m2 root the hash tests fingerprint under. */
const M2 = "/home/dev/.m2/repository";

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

/** Run `body` over fresh roots, cleaning them up afterwards. */
async function withRoots(count: number, body: (...roots: string[]) => Promise<void>): Promise<void> {
  const roots = Array.from({ length: count }, tmpProjectRoot);
  try {
    await body(...roots);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

/** Write the same small Gradle multi-module build into `root`. */
function sampleBuild(root: string): void {
  writeFileSync(join(root, "settings.gradle"), "rootProject.name = 'demo'\ninclude 'app'\n");
  writeFileSync(join(root, "build.gradle"), "plugins {}\n");
  mkdirSync(join(root, "app", "src", "main", "java"), { recursive: true });
  writeFileSync(join(root, "app", "build.gradle"), "plugins { id 'java' }\n");
}

describe("computeDependencySetHash", () => {
  it("is stable, and identical build files in two checkouts share one key", async () => {
    await withRoots(2, async (a, b) => {
      sampleBuild(a);
      sampleBuild(b);
      const keyA = await computeDependencySetHash(a, "auto", M2);
      expect(await computeDependencySetHash(a, "auto", M2)).toBe(keyA);
      expect(await computeDependencySetHash(b, "auto", M2)).toBe(keyA);
    });
  });

  it("keys on contents, not mtimes: a touch keeps the key, an edit moves it", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const before = await computeDependencySetHash(root, "auto", M2);
      touchPlusOneSecond(join(root, "app", "build.gradle"));
      expect(await computeDependencySetHash(root, "auto", M2)).toBe(before);
      writeFileSync(join(root, "app", "build.gradle"), "plugins { id 'java-library' }\n");
      expect(await computeDependencySetHash(root, "auto", M2)).not.toBe(before);
    });
  });

  it("a build with no build files keys on its own root (nothing to share by)", async () => {
    await withRoots(2, async (a, b) => {
      expect(await computeDependencySetHash(a, "auto", M2)).not.toBe(
        await computeDependencySetHash(b, "auto", M2),
      );
    });
  });

  it("changes on a new module build file, nested modules included", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const before = await computeDependencySetHash(root, "auto", M2);
      mkdirSync(join(root, "libs", "core", "api"), { recursive: true });
      writeFileSync(join(root, "libs", "core", "api", "build.gradle.kts"), "plugins { java }\n");
      expect(await computeDependencySetHash(root, "auto", M2)).not.toBe(before);
    });
  });

  it("fingerprints version catalogs, wrapper pins and .mvn config; skips src, outputs and dot-dirs", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      mkdirSync(join(root, "gradle", "wrapper"), { recursive: true });
      writeFileSync(join(root, "gradle", "libs.versions.toml"), "[versions]\n");
      writeFileSync(join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "x=1\n");
      mkdirSync(join(root, ".mvn"));
      writeFileSync(join(root, ".mvn", "maven.config"), "-B\n");
      // noise: a test-fixture project, build output, dependency tree, IDE state
      mkdirSync(join(root, "app", "src", "test", "resources", "fixture"), { recursive: true });
      writeFileSync(join(root, "app", "src", "test", "resources", "fixture", "pom.xml"), "<project/>");
      for (const noise of ["build", "node_modules", ".idea"]) {
        mkdirSync(join(root, noise), { recursive: true });
        writeFileSync(join(root, noise, "pom.xml"), "<project/>");
      }
      expect(buildFiles(root)).toEqual([
        ".mvn/maven.config",
        "app/build.gradle",
        "build.gradle",
        "gradle/libs.versions.toml",
        "gradle/wrapper/gradle-wrapper.properties",
        "settings.gradle",
      ]);
    });
  });

  it("includes the strategy and the effective m2 root", async () => {
    await withRoots(1, async (root) => {
      writeFileSync(join(root, "pom.xml"), "<project/>");
      const auto = await computeDependencySetHash(root, "auto", M2);
      expect(await computeDependencySetHash(root, "wrapper", M2)).not.toBe(auto);
      expect(await computeDependencySetHash(root, "system", M2)).not.toBe(auto);
      expect(await computeDependencySetHash(root, "auto", "/relocated/m2")).not.toBe(auto);
    });
  });
});

describe("readManifest / writeManifest", () => {
  it("missing manifest reads as null", async () => {
    await withRoots(1, async (root) => {
      expect(await readManifest(root, "auto", M2)).toBeNull();
      expect(lastManifestPath(root)).toBeNull();
    });
  });

  it("round-trips through the machine-wide cache, writing nothing into the project", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const key = await computeDependencySetHash(root, "auto", M2);
      const m: Manifest = manifestFor(key, [
        artifact({
          coordinates: "g:a:1.0",
          configuration: "compile",
          binaryJar: "/cache/a-1.0.jar",
          sourcesJar: "/cache/a-1.0-sources.jar",
          noDecompile: true,
        }),
        artifact({ coordinates: `module:${moduleNamespace(root)}:app`, kind: "module", sourceDir: join(root, "app") }),
      ]);
      await writeManifest(root, m);

      expect(await readManifest(root, "auto", M2)).toEqual(m);
      expect(lastManifestPath(root)).toBe(manifestPath(key));
      expect(existsSync(join(root, ".jarpeek"))).toBe(false);
      expect(readdirSync(join(process.env.JARPEEK_CACHE_DIR!, "manifests")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });

  it("a sibling checkout with identical build files reads the entry rebased onto itself", async () => {
    await withRoots(2, async (main, worktree) => {
      sampleBuild(main);
      sampleBuild(worktree);
      const key = await computeDependencySetHash(main, "auto", M2);
      await writeManifest(
        main,
        manifestFor(key, [
          artifact({ coordinates: "g:a:1.0", binaryJar: process.execPath }),
          artifact({ coordinates: `module:${moduleNamespace(main)}:app`, kind: "module", sourceDir: join(main, "app") }),
        ]),
      );

      const shared = await readManifest(worktree, "auto", M2);
      expect(shared?.artifacts).toEqual([
        // paths outside the checkout (the shared ~/.m2, here any real file) stay verbatim
        artifact({ coordinates: "g:a:1.0", binaryJar: process.execPath }),
        artifact({ coordinates: `module:${moduleNamespace(worktree)}:app`, kind: "module", sourceDir: join(worktree, "app") }),
      ]);
      expect(await isStale(worktree, shared!, "auto", M2)).toBe(false);
      // stored portable: no checkout path leaks into the shared file
      expect(readFileSync(manifestPath(key), "utf8")).not.toContain(main);
    });
  });

  it("after a build-file edit, the root's previous entry is served (and reads stale)", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const key = await computeDependencySetHash(root, "auto", M2);
      await writeManifest(root, manifestFor(key, [artifact({})]));

      writeFileSync(join(root, "build.gradle"), "plugins { id 'base' }\n");
      const served = await readManifest(root, "auto", M2);
      expect(served?.dependencySetHash).toBe(key);
      expect(await isStale(root, served!, "auto", M2)).toBe(true);
    });
  });

  it("corrupt, malformed-incomplete and v1-shaped entries read as null", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const key = await computeDependencySetHash(root, "auto", M2);
      mkdirSync(join(process.env.JARPEEK_CACHE_DIR!, "manifests"), { recursive: true });
      const base = { version: 2, resolvedAt: new Date().toISOString(), dependencySetHash: key, artifacts: [artifact({})] };
      for (const body of [
        "{not json",
        JSON.stringify({ ...base, incomplete: [{ from: "maven" }] }), // reason missing
        JSON.stringify({ ...base, incomplete: "modules failed" }), // not a list
        JSON.stringify({ ...base, incomplete: null }), // explicitly null, not absent
        JSON.stringify({ ...base, incomplete: [{ from: "cli", reason: "mangled" }] }), // unknown origin
        JSON.stringify({ ...base, version: 1 }), // layout bumps force a re-resolve
      ]) {
        writeFileSync(manifestPath(key), body);
        expect(await readManifest(root, "auto", M2)).toBeNull();
      }
    });
  });

  it("round-trips incomplete entries; an empty list reads as complete; absent stays absent (GH#18)", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const key = await computeDependencySetHash(root, "auto", M2);
      const partial: Manifest = {
        ...manifestFor(key, [artifact({ coordinates: "g:a:1.0" })]),
        incomplete: [{ from: "maven", reason: "modules failed to resolve: mod ([ERROR] sibling not found)" }],
      };
      await writeManifest(root, partial);
      expect(await readManifest(root, "auto", M2)).toEqual(partial);

      await writeManifest(root, { ...manifestFor(key, [artifact({})]), incomplete: [] });
      expect((await readManifest(root, "auto", M2))?.incomplete).toEqual([]);

      await writeManifest(root, manifestFor(key, [artifact({})]));
      expect((await readManifest(root, "auto", M2))?.incomplete).toBeUndefined();
    });
  });

  it("the written JSON omits absent optional fields", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      const key = await computeDependencySetHash(root, "auto", M2);
      await writeManifest(root, manifestFor(key, [artifact({ binaryJar: "/cache/lib.jar" })]));
      const raw = JSON.parse(readFileSync(manifestPath(key), "utf8")) as { artifacts: Array<Record<string, unknown>> };
      expect(raw.artifacts[0]!.binaryJar).toBe("/cache/lib.jar");
      expect(raw.artifacts[0]!.sourcesJar).toBeUndefined();
      expect(raw.artifacts[0]!.sourceDir).toBeUndefined();
    });
  });

  it("a write prunes entries unused for 30 days", async () => {
    await withRoots(1, async (root) => {
      sampleBuild(root);
      mkdirSync(join(process.env.JARPEEK_CACHE_DIR!, "manifests"), { recursive: true });
      const old = manifestPath("0".repeat(64));
      writeFileSync(old, "{}");
      const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      utimesSync(old, longAgo, longAgo);

      await writeManifest(root, manifestFor(await computeDependencySetHash(root, "auto", M2), [artifact({})]));
      expect(existsSync(old)).toBe(false);
    });
  });
});

describe("isStale", () => {
  it("a strategy or m2 root change alone flips staleness", async () => {
    await withRoots(1, async (root) => {
      writeFileSync(join(root, "pom.xml"), "<project/>");
      const m = manifestFor(await computeDependencySetHash(root, "wrapper", M2), [artifact({})]);
      expect(await isStale(root, m, "auto", M2)).toBe(true);
      expect(await isStale(root, m, "wrapper", M2)).toBe(false);
      expect(await isStale(root, m, "wrapper", "/relocated/m2")).toBe(true);
    });
  });

  it("flags a missing binary/sources jar or source dir even when the key matches", async () => {
    await withRoots(1, async (root) => {
      const key = await computeDependencySetHash(root, "auto", M2);
      mkdirSync(join(root, "mod"));
      writeFileSync(join(root, "a-sources.jar"), "jar");
      const present = manifestFor(key, [
        artifact({ sourcesJar: join(root, "a-sources.jar") }),
        artifact({ coordinates: ":mod", kind: "module", sourceDir: join(root, "mod") }),
      ]);
      expect(await isStale(root, present, "auto", M2)).toBe(false);
      const missing = manifestFor(key, [artifact({ binaryJar: join(root, "gone.jar") })]);
      expect(await isStale(root, missing, "auto", M2)).toBe(true);
    });
  });

  it("a module whose sources changed after resolving is NOT stale", async () => {
    // source-tree contents are not fingerprinted: the resolve-only manifest
    // only promises WHICH artifacts back the project
    await withRoots(1, async (root) => {
      const sourceDir = join(root, "src", "main", "java");
      mkdirSync(join(sourceDir, "com", "mod"), { recursive: true });
      writeFileSync(join(sourceDir, "com", "mod", "Thing.java"), "package com.mod;\nclass Thing {}\n");
      const m = manifestFor(await computeDependencySetHash(root, "auto", M2), [
        artifact({ coordinates: ":app", kind: "module", sourceDir }),
      ]);
      writeFileSync(join(sourceDir, "com", "mod", "Helper.kt"), "package com.mod\nclass Helper\n");
      expect(await isStale(root, m, "auto", M2)).toBe(false);
    });
  });
});

describe("withResolveLock", () => {
  it("serializes holders of the same key; other keys run concurrently", async () => {
    const events: string[] = [];
    const hold = (label: string, ms: number) => async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push(`${label}:end`);
    };
    let waited = 0;
    await Promise.all([
      withResolveLock("k1", hold("a", 300)),
      new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
        withResolveLock("k1", hold("b", 10), { onWait: () => waited++ }),
      ),
      withResolveLock("k2", hold("c", 10)),
    ]);
    expect(events.indexOf("b:start")).toBeGreaterThan(events.indexOf("a:end"));
    expect(events.indexOf("c:end")).toBeLessThan(events.indexOf("a:end"));
    expect(waited).toBe(1);
    expect(existsSync(join(process.env.JARPEEK_CACHE_DIR!, "locks", "k1.lock"))).toBe(false);
  });

  it("takes over a lock whose owner process is gone", async () => {
    mkdirSync(join(process.env.JARPEEK_CACHE_DIR!, "locks"), { recursive: true });
    writeFileSync(join(process.env.JARPEEK_CACHE_DIR!, "locks", "k3.lock"), "999999999");
    expect(await withResolveLock("k3", async () => "ran")).toBe("ran");
  });

  it("releases the lock when the holder throws", async () => {
    await expect(withResolveLock("k4", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withResolveLock("k4", async () => "again")).toBe("again");
  });
});
