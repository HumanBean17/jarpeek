/**
 * Workspace contexts: one build behaves exactly like a single project;
 * several builds answer over their union with every hit labeled by the
 * builds it comes from; a `project` hint scopes to one build; a failing
 * build makes the union honestly incomplete instead of silently smaller.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DependencyArtifact } from "../../src/core/types.js";
import { findClass } from "../../src/core/query/find-class.js";
import { outline } from "../../src/core/query/outline.js";
import { resolveNow } from "../../src/core/query/resolve-cmd.js";
import { status } from "../../src/core/query/status.js";
import { handleMiss } from "../../src/core/miss.js";
import { ProjectHintError, Workspace } from "../../src/workspace/workspace.js";
import type { ResolveDependenciesOptions } from "../../src/resolver/index.js";

const JARS = resolve(__dirname, "..", "fixtures", "jars");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");
const JVM = () => Promise.resolve({ available: false });

const demo = (version: string): DependencyArtifact => ({
  coordinates: `com.example:demo-lib:${version}`,
  kind: "external",
  sourcesJar: DEMO_SOURCES_JAR,
});
const nosources: DependencyArtifact = {
  coordinates: "com.example:nosources-lib:1.0.0",
  kind: "external",
  binaryJar: NOSOURCES_JAR,
};

const dirs: string[] = [];

beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "jarpeek-ws-cache-"));
  dirs.push(cache);
  process.env.JARPEEK_CACHE_DIR = cache;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git monorepo: svc/a (Maven) and svc/b (Gradle), plus a web app. */
function monorepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jarpeek-ws-")));
  dirs.push(root);
  for (const [rel, content] of Object.entries({
    "svc/a/pom.xml": `<project/><!-- ${root} -->`,
    "svc/b/build.gradle": `// ${root}\n`,
    "web/package.json": "{}",
  })) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

/** Maven answers for svc/a, Gradle for svc/b; counts runs per build. */
function resolvers(
  a: DependencyArtifact[],
  b: DependencyArtifact[] | "fail",
  calls: Record<string, number> = {},
): ResolveDependenciesOptions {
  return {
    includeJdk: false,
    maven: async (projectRoot) => {
      calls[projectRoot] = (calls[projectRoot] ?? 0) + 1;
      return { ok: true, artifacts: a };
    },
    gradle: async (projectRoot) => {
      calls[projectRoot] = (calls[projectRoot] ?? 0) + 1;
      return b === "fail" ? { ok: false, artifacts: [], reason: "boom" } : { ok: true, artifacts: b };
    },
    cacheScan: async () => ({ artifacts: [], warnings: [] }),
  };
}

describe("Workspace", () => {
  it("a monorepo root answers over every build, each hit naming its builds", async () => {
    const root = monorepo();
    const calls: Record<string, number> = {};
    const ctx = new Workspace([root], { resolvers: resolvers([demo("1.0.0")], [demo("1.0.0"), nosources], calls) }).context();
    expect(ctx.members?.map((m) => m.project)).toEqual(["svc/a", "svc/b"]);

    const demoHits = await findClass(ctx, "com.example.Demo", { jvm: JVM });
    expect(demoHits.hits).toEqual([expect.objectContaining({ coordinates: "com.example:demo-lib:1.0.0", projects: ["svc/a", "svc/b"] })]);
    const hidden = await findClass(ctx, "Hidden", { jvm: JVM });
    expect(hidden.hits[0]).toEqual(expect.objectContaining({ projects: ["svc/b"] }));
    // each build resolved once, by its own build tool
    expect(calls).toEqual({ [join(root, "svc", "a")]: 1, [join(root, "svc", "b")]: 1 });
  });

  it("a version conflict across builds serves one and names the other's build", async () => {
    const root = monorepo();
    const ctx = new Workspace([root], { resolvers: resolvers([demo("1.0.0")], [demo("2.0.0")]) }).context();
    const result = await outline(ctx, "com.example.Demo");
    expect(result.coordinates).toBe("com.example:demo-lib:1.0.0");
    expect(result.projects).toEqual(["svc/a"]);
    expect(result.alternatives).toEqual([{ coordinates: "com.example:demo-lib:2.0.0", projects: ["svc/b"] }]);

    // the hint scopes the same query to the other build
    const scoped = await outline(new Workspace([root], { resolvers: resolvers([demo("1.0.0")], [demo("2.0.0")]) }).context("svc/b"), "com.example.Demo");
    expect(scoped.coordinates).toBe("com.example:demo-lib:2.0.0");
    expect(scoped.projects).toBeUndefined();
  });

  it("project hints: a label, a unique suffix, or any path inside a build", () => {
    const root = monorepo();
    const ws = new Workspace([root], { resolvers: resolvers([], []) });
    expect(ws.context("svc/a").projectRoot).toBe(join(root, "svc", "a"));
    expect(ws.context("b").projectRoot).toBe(join(root, "svc", "b"));
    mkdirSync(join(root, "svc", "a", "src", "main"), { recursive: true });
    expect(ws.context(join(root, "svc", "a", "src", "main")).projectRoot).toBe(join(root, "svc", "a"));
    expect(ws.context("svc").members?.map((m) => m.project)).toEqual(["svc/a", "svc/b"]);
  });

  it("an unknown hint is a usage error listing the builds", () => {
    const root = monorepo();
    const ws = new Workspace([root], { resolvers: resolvers([], []) });
    expect(() => ws.context("web")).toThrow(ProjectHintError);
    expect(() => ws.context("nope")).toThrow("builds in this workspace: svc/a, svc/b");
  });

  it("a failing build: the others still answer, the union is flagged incomplete with a labeled warning", async () => {
    const root = monorepo();
    const ctx = new Workspace([root], { resolvers: resolvers([demo("1.0.0")], "fail") }).context();
    await ctx.ensureReady();
    expect((await findClass(ctx, "com.example.Demo", { jvm: JVM })).hits).toHaveLength(1);

    const miss = await handleMiss(ctx, { query: "NoSuchThing" });
    expect(miss).toEqual(expect.objectContaining({ found: false, incomplete: true }));
    expect((await ctx.bootstrapWarnings()).some((w) => w.startsWith("svc/b: "))).toBe(true);
  });

  it("status and resolve report per build", async () => {
    const root = monorepo();
    const ctx = new Workspace([root], { resolvers: resolvers([demo("1.0.0")], [demo("1.0.0"), nosources]) }).context();
    const resolved = await resolveNow(ctx);
    expect(resolved.artifactCount).toBe(2); // the union, deduplicated
    expect(resolved.projects?.map((p) => [p.project, p.artifactCount])).toEqual([
      ["svc/a", 1],
      ["svc/b", 2],
    ]);
    const report = await status(ctx, { jvm: JVM });
    expect(report.manifest).toEqual(expect.objectContaining({ present: true, artifactCount: 2, stale: false }));
    expect(report.manifest.path).toBeUndefined();
    expect(report.projects?.map((p) => [p.project, p.manifest.artifactCount, typeof p.manifest.path])).toEqual([
      ["svc/a", 1, "string"],
      ["svc/b", 2, "string"],
    ]);
  });

  it("a batch announces itself once, whatever the build count; a fresh workspace says nothing", async () => {
    const root = monorepo();
    const notices: string[] = [];
    const opts = { resolvers: resolvers([demo("1.0.0")], [nosources]), onNotice: (msg: string) => notices.push(msg) };
    await new Workspace([root], opts).context().ensureReady();
    expect(notices).toEqual(["resolving dependencies for 2 builds (svc/a, svc/b)"]);

    notices.length = 0;
    await new Workspace([root], opts).context().ensureReady();
    expect(notices).toEqual([]);
  });

  it("one build: its own plain context; no build: the directory itself", () => {
    const root = monorepo();
    const single = new Workspace([join(root, "svc", "a")], { resolvers: resolvers([], []) }).context();
    expect(single.members).toBeUndefined();
    expect(single.projectRoot).toBe(join(root, "svc", "a"));

    const none = new Workspace([join(root, "web")], { resolvers: resolvers([], []) }).context();
    expect(none.members).toBeUndefined();
    expect(none.projectRoot).toBe(join(root, "web"));
  });
});
