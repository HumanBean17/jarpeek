import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyArtifact } from "../../src/core/types.js";
import { detectBuildSystems } from "../../src/resolver/detect.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";
import { resolveDependencies } from "../../src/resolver/index.js";
import type { GradleResolution } from "../../src/resolver/gradle.js";
import type { MavenResolution } from "../../src/resolver/maven.js";
import type { ScanCachesResult } from "../../src/resolver/cache-scan.js";
import type { ResolveJdkResult } from "../../src/resolver/jdk.js";

let root: string | undefined;

/** Fresh scratch directory (removed in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-facade-"));
  return root;
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** Minimal artifact for coordinate-level assertions. */
function artifact(coordinates: string, kind: DependencyArtifact["kind"] = "external"): DependencyArtifact {
  return { coordinates, kind, provenance: "source", warnings: [] };
}

interface FakeSpec {
  gradle?: GradleResolution;
  maven?: MavenResolution;
  cacheScan?: ScanCachesResult;
  jdk?: ResolveJdkResult;
}

/** Injectable resolver fakes recording every call made through them. */
function fakes(spec: FakeSpec = {}): {
  calls: { gradle: string[]; maven: string[]; cacheScan: number; jdk: number };
  opts: ResolveDependenciesOptions;
} {
  const calls = { gradle: [] as string[], maven: [] as string[], cacheScan: 0, jdk: 0 };
  return {
    calls,
    opts: {
      gradle: async (projectRoot: string): Promise<GradleResolution> => {
        calls.gradle.push(projectRoot);
        return spec.gradle ?? { ok: false, artifacts: [], reason: "not-detected" };
      },
      maven: async (projectRoot: string): Promise<MavenResolution> => {
        calls.maven.push(projectRoot);
        return spec.maven ?? { ok: false, artifacts: [], reason: "not-detected" };
      },
      cacheScan: async (): Promise<ScanCachesResult> => {
        calls.cacheScan++;
        return spec.cacheScan ?? { artifacts: [], warnings: [] };
      },
      jdk: async (): Promise<ResolveJdkResult> => {
        calls.jdk++;
        return spec.jdk ?? { artifact: null, warnings: [] };
      },
    },
  };
}

describe("detectBuildSystems", () => {
  it("detects nothing in an empty directory", () => {
    expect(detectBuildSystems(scratch())).toEqual([]);
  });

  const GRADLE_MARKERS = [
    "settings.gradle",
    "settings.gradle.kts",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    "gradlew.bat",
  ];
  for (const marker of GRADLE_MARKERS) {
    it(`detects gradle from ${marker}`, () => {
      const dir = scratch();
      writeFileSync(join(dir, marker), "");
      expect(detectBuildSystems(dir)).toEqual(["gradle"]);
    });
  }

  it("detects maven from pom.xml", () => {
    const dir = scratch();
    writeFileSync(join(dir, "pom.xml"), "");
    expect(detectBuildSystems(dir)).toEqual(["maven"]);
  });

  it("detects both with gradle first", () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    writeFileSync(join(dir, "pom.xml"), "");
    expect(detectBuildSystems(dir)).toEqual(["gradle", "maven"]);
  });
});

describe("resolveDependencies", () => {
  it("gradle-only project: gradle result wins, maven and cache scan never run", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    const f = fakes({
      gradle: { ok: true, artifacts: [artifact("org.example:alpha:1.0")] },
      maven: { ok: true, artifacts: [artifact("com.example:beta:2.0")] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["org.example:alpha:1.0"]);
    expect(f.calls.gradle).toEqual([dir]);
    expect(f.calls.maven).toHaveLength(0);
    expect(f.calls.cacheScan).toBe(0);
    expect(out.degraded).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it("gradle failure falls through to maven; degraded records the gradle failure", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    writeFileSync(join(dir, "pom.xml"), "");
    const f = fakes({
      gradle: { ok: false, artifacts: [], reason: "timeout" },
      maven: { ok: true, artifacts: [artifact("com.example:beta:2.0")] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["com.example:beta:2.0"]);
    expect(out.degraded).toEqual([{ from: "gradle", reason: "timeout" }]);
    expect(f.calls.cacheScan).toBe(0);
    expect(out.warnings).toEqual([]);
  });

  it("both fail: cache-scan artifacts used, warning emitted, two degraded entries", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    writeFileSync(join(dir, "pom.xml"), "");
    const f = fakes({
      gradle: { ok: false, artifacts: [], reason: "timeout" },
      maven: { ok: false, artifacts: [], reason: "no-mvn" },
      cacheScan: {
        artifacts: [artifact("org.cache:one:1"), artifact("org.cache:two:2")],
        warnings: ["cache-scan-truncated:42"],
      },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["org.cache:one:1", "org.cache:two:2"]);
    expect(out.degraded).toEqual([
      { from: "gradle", reason: "timeout" },
      { from: "maven", reason: "no-mvn" },
    ]);
    expect(out.warnings).toContain("degraded-to-cache-scan");
    expect(out.warnings).toContain("cache-scan-truncated:42");
  });

  it("ok-but-empty resolution does not win; reason falls back to no-artifacts", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    writeFileSync(join(dir, "pom.xml"), "");
    const f = fakes({
      gradle: { ok: true, artifacts: [] },
      maven: { ok: false, artifacts: [], reason: "no-mvn" },
      cacheScan: { artifacts: [artifact("org.cache:one:1")], warnings: [] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["org.cache:one:1"]);
    expect(out.degraded).toEqual([
      { from: "gradle", reason: "no-artifacts" },
      { from: "maven", reason: "no-mvn" },
    ]);
  });

  it("jdk artifact is appended after build artifacts with its warnings merged", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    const f = fakes({
      gradle: { ok: true, artifacts: [artifact("org.example:alpha:1.0")] },
      jdk: { artifact: artifact("jdk:25.0.2", "jdk"), warnings: ["jdk-version-unknown"] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["org.example:alpha:1.0", "jdk:25.0.2"]);
    expect(out.artifacts[1].kind).toBe("jdk");
    expect(out.warnings).toEqual(["jdk-version-unknown"]);
  });

  it("jdk artifact is not duplicated when the build already reports the same coordinates", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    const f = fakes({
      gradle: { ok: true, artifacts: [artifact("jdk:25.0.2", "jdk")] },
      jdk: { artifact: artifact("jdk:25.0.2", "jdk"), warnings: [] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["jdk:25.0.2"]);
  });

  it("includeJdk:false skips the jdk resolver entirely", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    const f = fakes({
      gradle: { ok: true, artifacts: [artifact("org.example:alpha:1.0")] },
      jdk: { artifact: artifact("jdk:25.0.2", "jdk"), warnings: ["jdk-version-unknown"] },
    });

    const out = await resolveDependencies(dir, { ...f.opts, includeJdk: false });

    expect(f.calls.jdk).toBe(0);
    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["org.example:alpha:1.0"]);
    expect(out.warnings).toEqual([]);
  });

  it("dedups by coordinates keeping the first occurrence (module sourceDir preserved)", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "settings.gradle"), "");
    const moduleFirst: DependencyArtifact = {
      coordinates: "org.example:mod:1.0",
      kind: "module",
      sourceDir: "/work/mod",
      provenance: "source",
      warnings: [],
    };
    const f = fakes({
      gradle: { ok: true, artifacts: [moduleFirst, artifact("org.example:mod:1.0")] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0].kind).toBe("module");
    expect(out.artifacts[0].sourceDir).toBe("/work/mod");
  });

  it("empty dir: no resolvers detected, cache scan + jdk only, warnings merged, no throw", async () => {
    const dir = scratch();
    const f = fakes({
      cacheScan: { artifacts: [], warnings: ["cache-scan-truncated:7"] },
      jdk: { artifact: artifact("jdk:21", "jdk"), warnings: ["src.zip missing; using jimage-extracted class files (signatures only)"] },
    });

    const out = await resolveDependencies(dir, f.opts);

    expect(f.calls.gradle).toHaveLength(0);
    expect(f.calls.maven).toHaveLength(0);
    expect(f.calls.cacheScan).toBe(1);
    expect(out.artifacts.map((a) => a.coordinates)).toEqual(["jdk:21"]);
    expect(out.degraded).toEqual([]);
    expect(out.warnings).toContain("cache-scan-truncated:7");
    expect(out.warnings).toContain("src.zip missing; using jimage-extracted class files (signatures only)");
    expect(out.warnings).toContain("degraded-to-cache-scan");
  });
});
