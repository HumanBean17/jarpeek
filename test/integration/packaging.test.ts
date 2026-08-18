/**
 * Packaging contract tests: the published tarball must be runnable as-is.
 *
 * A user's first contact with jarpeek is `npx jarpeek@latest init` — whatever
 * that downloads has to contain the built CLI, the bundled CFR jar, and none
 * of the development surface (src/, test/, scripts/). The assertions here
 * pin the three levers that guarantee it: the `files` allowlist, the runtime
 * dependency set (exact — accidental additions ship to every consumer), and
 * the absence of lifecycle scripts (an install-time hook would be code
 * running on `npm install`, which this package must never do).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/version.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PkgJson {
  bin?: Record<string, string>;
  engines?: { node?: string };
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  license?: string;
  description?: string;
  repository?: { url?: string };
  keywords?: string[];
}

interface PackEntry {
  path: string;
}

interface PackManifest {
  files?: PackEntry[];
}

/**
 * Parse `npm pack --dry-run --json` output into the packed-path list. npm 10
 * prints one pretty-printed JSON array (older/newer shapes emit NDJSON
 * objects) — accept both so the assertion tests the policy, not the format.
 */
function packedPaths(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    return ((JSON.parse(trimmed) as PackManifest[])[0]?.files ?? []).map((entry) => entry.path);
  }
  return trimmed
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => (JSON.parse(line) as PackEntry).path);
}

function readPkg(): PkgJson {
  return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as PkgJson;
}

/** One npm command in the package root; stdout as JSON lines or text. */
function npm(args: string): string {
  return execFileSync("npm", args.split(" "), { cwd: PKG_ROOT, encoding: "utf8" });
}

describe("packaging", () => {
  it("ships exactly the intended runtime dependency set", () => {
    expect(Object.keys(readPkg().dependencies ?? {}).sort()).toEqual([
      "@clack/prompts",
      "@modelcontextprotocol/sdk",
      "commander",
    ]);
  });

  it("declares no install-time lifecycle scripts", () => {
    const scripts = Object.keys(readPkg().scripts ?? {});
    for (const forbidden of ["preinstall", "install", "postinstall"]) {
      expect(scripts, `scripts.${forbidden} must not exist`).not.toContain(forbidden);
    }
    // prepublishOnly is the one allowed publish-gate script, and it re-runs the suite
    expect(readPkg().scripts?.prepublishOnly).toBe("npm run build && npm test");
  });

  it("publishes vendor (CFR) alongside dist", () => {
    expect(readPkg().files).toContain("vendor");
    expect(readPkg().files).toContain("dist");
    expect(readPkg().bin).toEqual({ jarpeek: "dist/cli/index.js" });
  });

  it("carries the npm registry metadata: license, description, repository, keywords", () => {
    const pkg = readPkg();
    expect(pkg.license).toBe("MIT");
    expect(pkg.description).toMatch(/JVM dependency sources/i);
    expect(pkg.repository?.url).toContain("github.com/HumanBean17/jarpeek");
    expect(pkg.keywords).toEqual(["mcp", "jvm", "java", "kotlin", "dependencies", "ai-agents"]);
  });

  it("pins the engines floor the runtime dep closure requires", () => {
    expect(readPkg().engines?.node).toBe(">=20.12.0");
  });

  it("builds a directly executable CLI entry", () => {
    npm("run build");
    const entry = join(PKG_ROOT, "dist", "cli", "index.js");
    expect(existsSync(entry), `${entry} exists after npm run build`).toBe(true);
    expect(readFileSync(entry, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("packs vendor/cfr.jar and dist/cli/index.js, never src/test/scripts", () => {
    const paths = packedPaths(npm("pack --dry-run --json"));
    expect(paths).toContain("vendor/cfr.jar");
    expect(paths).toContain("dist/cli/index.js");
    for (const banned of ["src/", "test/", "scripts/"]) {
      expect(
        paths.filter((path) => path.startsWith(banned)),
        `no packed file under ${banned}`,
      ).toEqual([]);
    }
  });

  it("packs CFR's MIT license (attribution travels with the binary)", () => {
    const paths = packedPaths(npm("pack --dry-run --json"));
    expect(paths).toContain("vendor/cfr-LICENSE.txt");
    const license = readFileSync(join(PKG_ROOT, "vendor", "cfr-LICENSE.txt"), "utf8");
    expect(license).toContain("MIT");
    expect(license).toContain("Lee Benfield");
  });

  it("documents install, usage, and provenance in the README", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    for (const heading of ["## Install", "## Usage", "## Provenance"]) {
      expect(readme, `README contains "${heading}"`).toContain(heading);
    }
  });

  it("carries an MIT license for 2026", () => {
    const license = readFileSync(join(PKG_ROOT, "LICENSE"), "utf8");
    expect(license).toContain("MIT");
    expect(license).toContain("jarpeek contributors");
    expect(license).toContain("2026");
  });

  it("ships one version: src/version.ts matches package.json", () => {
    const pkg = readPkg();
    expect(VERSION).toBe(pkg.version);
  });
});
