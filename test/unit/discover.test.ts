/**
 * Build discovery: up to the enclosing build (Gradle's and Maven's own
 * root rules, bounded by the repository root), down to every build below a
 * monorepo / multi-repo directory (git-aware, fixture-blind).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { buildsBelow, discoverBuilds, enclosingBuild } from "../../src/workspace/discover.js";

const roots: string[] = [];

/** A scratch tree (realpath'd: macOS /var → /private/var) with the given files. */
function tree(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jarpeek-discover-")));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  if (opts.git === true) git(root, "init", "-q");
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function commitAll(root: string): void {
  git(root, "add", "-A");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

const rels = (root: string): string[] =>
  buildsBelow(root).map((b) => (b === root ? "." : relative(root, b).split(sep).join("/")));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("enclosingBuild", () => {
  it("Gradle: the nearest settings file wins over nearer subproject build files", () => {
    const root = tree({ "settings.gradle": "", "app/build.gradle": "", "app/src/main/java/A.java": "" }, { git: true });
    expect(enclosingBuild(join(root, "app", "src", "main", "java"))).toBe(root);
  });

  it("Gradle without settings: the nearest build file", () => {
    const root = tree({ "lib/build.gradle.kts": "", "lib/src/x.kt": "" }, { git: true });
    expect(enclosingBuild(join(root, "lib", "src"))).toBe(join(root, "lib"));
  });

  it("Maven: the outermost pom of the contiguous parent chain", () => {
    const root = tree({ "svc/pom.xml": "", "svc/core/pom.xml": "", "svc/core/src/A.java": "" }, { git: true });
    expect(enclosingBuild(join(root, "svc", "core", "src"))).toBe(join(root, "svc"));
  });

  it("Maven: .mvn/ marks the multi-module root even below another pom", () => {
    const root = tree({ "pom.xml": "", "svc/pom.xml": "", "svc/.mvn/maven.config": "", "svc/core/pom.xml": "" }, { git: true });
    expect(enclosingBuild(join(root, "svc", "core"))).toBe(join(root, "svc"));
  });

  it("never climbs past the repository root", () => {
    const outer = tree({ "pom.xml": "" });
    mkdirSync(join(outer, "repo", "src"), { recursive: true });
    git(join(outer, "repo"), "init", "-q");
    expect(enclosingBuild(join(outer, "repo", "src"))).toBeNull();
  });

  it("a monorepo root that is not itself a build has no enclosing build", () => {
    const root = tree({ "svc/a/pom.xml": "", "README.md": "" }, { git: true });
    expect(enclosingBuild(root)).toBeNull();
  });
});

describe("buildsBelow", () => {
  it("git: tracked and untracked builds, nested repositories, no ignored or fixture dirs", () => {
    const root = tree(
      {
        "services/a/pom.xml": "",
        "services/a/module/pom.xml": "",
        "services/b/settings.gradle.kts": "",
        "services/b/app/build.gradle.kts": "",
        "web/package.json": "{}",
        "tools/test/fixtures/sample/pom.xml": "",
        "services/c/src/test/resources/proj/pom.xml": "",
        ".gitignore": "generated/\n",
        "generated/pom.xml": "",
      },
      { git: true },
    );
    commitAll(root);
    // added after the commit: a wholly untracked new service and a nested repo
    mkdirSync(join(root, "services", "new"), { recursive: true });
    writeFileSync(join(root, "services", "new", "build.gradle"), "");
    mkdirSync(join(root, "vendor-repo"));
    git(join(root, "vendor-repo"), "init", "-q");
    writeFileSync(join(root, "vendor-repo", "pom.xml"), "");

    expect(rels(root).sort()).toEqual(["services/a", "services/b", "services/new", "vendor-repo"]);
    // the session hook's cheap mode: the git index only
    const tracked = buildsBelow(root, { untracked: false }).map((b) => b.slice(root.length + 1));
    expect(tracked.sort()).toEqual(["services/a", "services/b"]);
  });

  it("outside git: a bounded walk that stops at build roots and skips dependency dirs", () => {
    const root = tree({
      "repo-a/pom.xml": "",
      "repo-a/sub/pom.xml": "",
      "repo-b/settings.gradle": "",
      "node_modules/x/pom.xml": "",
      ".cache/pom.xml": "",
    });
    expect(rels(root).sort()).toEqual(["repo-a", "repo-b"]);
  });
});

describe("discoverBuilds", () => {
  it("inside a build: that build, labeled as the workspace itself", () => {
    const root = tree({ "settings.gradle": "", "app/build.gradle": "" }, { git: true });
    const found = discoverBuilds(join(root, "app"));
    expect(found.via).toBe("enclosing");
    expect(found.builds).toEqual([{ root, rel: ".", systems: ["gradle"] }]);
  });

  it("above builds: every build below, labeled relative to the workspace", () => {
    const root = tree({ "svc/a/pom.xml": "", "svc/b/build.gradle": "" }, { git: true });
    const found = discoverBuilds(root);
    expect(found.via).toBe("below");
    expect(found.builds.map((b) => [b.rel, b.systems])).toEqual([
      ["svc/a", ["maven"]],
      ["svc/b", ["gradle"]],
    ]);
  });

  it("no build anywhere: none", () => {
    const root = tree({ "package.json": "{}" }, { git: true });
    expect(discoverBuilds(root)).toEqual({ builds: [], via: "none", truncated: false });
  });
});
