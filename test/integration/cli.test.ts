/**
 * CLI transport integration tests: every subcommand as a real subprocess.
 *
 * The suite bootstraps a tmp project in-process (openContext + injected
 * gradle resolver writing the manifest through the real resolve-only flow),
 * so the spawned CLI finds a fresh manifest and never needs resolver
 * injection across the process boundary — both sides serve the identical
 * artifact set, which is what makes the --json parity assertions exact.
 * `resolve` gets its own project with a fake `gradlew` that prints the
 * sentinel dump, exercising the real resolver cascade end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import { findClass } from "../../src/core/query/find-class.js";
import { outline } from "../../src/core/query/outline.js";
import { readMember } from "../../src/core/query/read-member.js";
import { readResource } from "../../src/core/query/read-resource.js";
import { readSource } from "../../src/core/query/read-source.js";
import { resolveNow } from "../../src/core/query/resolve-cmd.js";
import { searchSymbols } from "../../src/core/query/search-symbols.js";
import { status } from "../../src/core/query/status.js";
import { where } from "../../src/core/query/where.js";
import type { DependencyArtifact } from "../../src/core/types.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JARS = join(PKG_ROOT, "test", "fixtures", "jars");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");
const NOSOURCES_JAR = join(JARS, "nosources-lib-1.0.0.jar");

interface Suite {
  projectRoot: string;
  ctx: QueryContext;
}

/**
 * One backing per artifact (the fixture-manifest rule): demo-lib declares
 * its SOURCES jar so locate parses source records (the outline/read parity
 * cases assert source-lexer signatures); demo-lib-bin carries the binary
 * jar for the resource-half case; nosources-lib is binary-only.
 */
function demoArtifacts(): DependencyArtifact[] {
  return [
    {
      coordinates: "com.example:demo-lib:1.0.0",
      kind: "external",
      sourcesJar: DEMO_SOURCES_JAR,
    },
    {
      coordinates: "com.example:demo-lib-bin:1.0.0",
      kind: "external",
      binaryJar: DEMO_JAR,
    },
    {
      coordinates: "com.example:nosources-lib:1.0.0",
      kind: "external",
      binaryJar: NOSOURCES_JAR,
    },
  ];
}

/** A project whose gradle resolver always answers the fixture artifact set. */
function openSuite(artifacts: () => DependencyArtifact[] | null): Suite {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-cli-project-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  const injected = artifacts();
  const ctx = openContext(projectRoot, {
    // `null` means "use the real cascade" — the resolve suite's fake gradlew
    // must be exercised by the real resolver in both processes
    ...(injected === null
      ? {}
      : { resolvers: { gradle: async () => ({ ok: true, artifacts: injected }), includeJdk: false } }),
  });
  return { projectRoot, ctx };
}

const c = {} as Suite;
const resolveSuite = {} as Suite;
const suites: Suite[] = [];

/**
 * A `gradlew` that succeeds and prints the sentinel JSON dump — the resolve
 * command's subprocess then runs the real gradle resolver against it.
 */
function writeFakeGradlew(projectRoot: string, jar: string, sourcesJar: string): void {
  const script = [
    "#!/bin/sh",
    // the coordinates argument split keeps the JSON a single awk-free line
    `echo '###JARPEEK-BEGIN###'`,
    `echo '{"configurations":[{"name":"compileClasspath","dependencies":[{"coordinates":"com.example:demo-lib:1.0.0","kind":"external","path":"${jar}"}]}],"sources":{"com.example:demo-lib:1.0.0":"${sourcesJar}"}}'`,
    `echo '###JARPEEK-END###'`,
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(projectRoot, "gradlew"), script, { mode: 0o755 });
  chmodSync(join(projectRoot, "gradlew"), 0o755);
}

beforeAll(async () => {
  Object.assign(c, openSuite(() => demoArtifacts()));
  await c.ctx.ensureReady(); // build the manifest before any subprocess

  Object.assign(resolveSuite, openSuite(() => null));
  suites.push(c, resolveSuite);
});

afterAll(() => {
  for (const s of suites) {
    rmSync(s.projectRoot, { recursive: true, force: true });
  }
});

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn the CLI as `npx tsx` with `--project` pointing at a bootstrapped root. */
function cli(suite: Suite, args: string[], env: Record<string, string> = {}): CliRun {
  const run = spawnSync(
    "npx",
    ["tsx", "src/cli/index.ts", "--project", suite.projectRoot, ...args],
    {
      cwd: PKG_ROOT,
      encoding: "utf8",
      // the manifest under --project is the only shared state between this
      // process and the subprocess — the parity assertions compare against it
      env: { ...process.env, ...env },
      timeout: 60_000,
    },
  );
  return {
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    code: run.status ?? 1,
  };
}

/** stdout of a --json run, parsed; fails the test when the exit is nonzero. */
function jsonRun(suite: Suite, args: string[]): unknown {
  const run = cli(suite, ["--json", ...args]);
  expect(run.code, `--json ${args.join(" ")} should exit 0 (stderr: ${run.stderr})`).toBe(0);
  return JSON.parse(run.stdout);
}

describe("find-class", () => {
  it("human table carries FQN and artifact columns", () => {
    const run = cli(c, ["find-class", "com.example.Demo"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("com.example.Demo");
    expect(run.stdout).toContain("demo-lib");
    expect(run.stdout).toContain("FQN");
    expect(run.stdout).toContain("PROVENANCE");
  });

  it("--json deep-equals the in-process findClass result", async () => {
    const expected = await findClass(c.ctx, "com.example.Demo");
    expect(jsonRun(c, ["find-class", "com.example.Demo"])).toEqual(expected);
  });

  it("--limit N bounds the table rows", () => {
    const run = cli(c, ["find-class", "e", "--limit", "3"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("com.example.Demo");
  });

  it("definitive miss exits 0 with the negative on stdout", () => {
    const run = cli(c, ["find-class", "ZzzzNoMatch"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("not found");
    expect(run.stdout).toContain("remote artifact search is a planned extension");
    expect(run.stdout).toContain("com.example:demo-lib:1.0.0"); // the searched set
  });

  it("miss negative also prints in --json mode and exits 0", () => {
    const run = cli(c, ["--json", "find-class", "ZzzzNoMatch"]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as { found: boolean; via: string };
    expect(parsed.found).toBe(false);
    expect(parsed.via).toBe("negative");
  });
});

describe("outline", () => {
  it("human table has SELECTOR/KIND/VIS/STATIC/DEP/SIGNATURE headers", () => {
    const run = cli(c, ["outline", "com.example.Demo"]);
    expect(run.code).toBe(0);
    for (const header of ["SELECTOR", "KIND", "VIS", "STATIC", "DEP", "SIGNATURE"]) {
      expect(run.stdout).toContain(header);
    }
  });

  it("--kind method filters to method rows only", () => {
    const run = cli(c, ["outline", "com.example.Demo", "--kind", "method"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("run");
    expect(run.stdout).not.toContain("NAME");
    expect(run.stdout).not.toContain("field");
  });

  it("--kind class filters to the class row", () => {
    const run = cli(c, ["outline", "com.example.Demo", "--kind", "class"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Demo");
    expect(run.stdout).not.toContain("method");
  });

  it("--visibility public filters", () => {
    const run = cli(c, ["outline", "com.example.Demo", "--kind", "method", "--visibility", "public"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("run(String,int)");
    expect(run.stdout).not.toContain("run()");
  });

  it("--json deep-equals the in-process outline result", async () => {
    const expected = await outline(c.ctx, "com.example.Demo", { kind: "method" });
    expect(jsonRun(c, ["outline", "com.example.Demo", "--kind", "method"])).toEqual(expected);
  });

  it("unknown class routes through the miss protocol and exits 0", () => {
    const run = cli(c, ["outline", "com.example.ZzzzNoMatch"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("not found");
  });
});

describe("read-member", () => {
  it("served member prints a lines header, then the member lines verbatim", () => {
    const run = cli(c, ["read-member", "com.example.Demo", "#run(String,int)"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("com.example.Demo#run(String,int)");
    expect(run.stdout).toMatch(/lines 11–2[0-9]/);
    expect(run.stdout).toContain("public Object run(String input, int count) throws Exception {");
    expect(run.stdout).toContain("Runs the demo transformation over the given input.");
  });

  it("comma-joined selector list and space-separated args behave identically", () => {
    const joined = cli(c, ["read-member", "com.example.Demo", "#run,#NAME"]);
    expect(joined.code).toBe(0);
    expect(joined.stdout).toContain("com.example.Demo#NAME");
    expect(joined.stdout).toContain('private static final String NAME = "demo";');

    const split = cli(c, ["read-member", "com.example.Demo", "#run", "#NAME"]);
    expect(split.code).toBe(0);
    expect(split.stdout).toContain("com.example.Demo#NAME");
  });

  it("--json deep-equals the in-process readMember result", async () => {
    const expected = await readMember(c.ctx, "com.example.Demo", "#run(String,int),#NAME");
    expect(jsonRun(c, ["read-member", "com.example.Demo", "#run(String,int),#NAME"])).toEqual(expected);
  });

  it("malformed selector (no #) exits 1 with the usage message on stderr", () => {
    const run = cli(c, ["read-member", "com.example.Demo", "run"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("#");
    expect(run.stderr).toContain("Usage:");
    expect(run.stdout).not.toContain("com.example.Demo#");
  });

  it("degraded no-source member prints its signature row either way it degrades", () => {
    // nosources-lib is binary-only: with a JVM it decompiles, without one it
    // degrades to a signature row — either way the member is served, not fatal
    const run = cli(c, ["read-member", "com.example.nosources.Hidden", "#secret()"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("com.example.nosources.Hidden#secret()");
    expect(run.stdout).toContain("secret");
  });
});

describe("read-source", () => {
  it("--full prints the header then numbered lines from line 1", () => {
    const run = cli(c, ["read-source", "com.example.Demo", "--full"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("file com/example/Demo.java");
    expect(run.stdout).toContain("provenance source");
    expect(run.stdout).toContain("1│ package com.example;");
    expect(run.stdout).toContain("19│     public Object run(String input, int count) throws Exception {");
  });

  it("--lines 2:3 prints exactly two numbered lines", () => {
    const run = cli(c, ["read-source", "com.example.Demo", "--lines", "2:3"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("file com/example/Demo.java");
    const numbered = run.stdout.split("\n").filter((l) => /^\d+│ /.test(l));
    // fixture line 2 is blank, line 3 opens the class javadoc
    expect(numbered).toEqual(["2│ ", "3│ /**"]);
  });

  it("default mode renders the outline rows", () => {
    const run = cli(c, ["read-source", "com.example.Demo"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("SELECTOR");
    expect(run.stdout).toContain("run(String,int)");
  });

  it("--json deep-equals the in-process readSource result", async () => {
    const full = await readSource(c.ctx, "com.example.Demo", { mode: "full" });
    expect(jsonRun(c, ["read-source", "com.example.Demo", "--full"])).toEqual(full);

    const lines = await readSource(c.ctx, "com.example.Demo", { mode: "lines", from: 2, to: 3 });
    expect(jsonRun(c, ["read-source", "com.example.Demo", "--lines", "2:3"])).toEqual(lines);
  });

  it("malformed --lines exits 1", () => {
    const run = cli(c, ["read-source", "com.example.Demo", "--lines", "abc"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--lines");
  });
});

describe("read-resource", () => {
  it("prints text entry content", () => {
    const run = cli(c, ["read-resource", "com.example:demo-lib-bin:1.0.0", "config/*"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("config/app.properties");
    expect(run.stdout).toContain("key=value");
  });

  it("binary entries print a note without content", () => {
    const run = cli(c, ["read-resource", "demo-lib-bin", "logo.png"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("binary entry — content omitted");
  });

  it("glob matching nothing prints an empty listing and exits 0", () => {
    const run = cli(c, ["read-resource", "demo-lib-bin", "no/such/**"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("no matching entries");
  });

  it("--json deep-equals the in-process readResource result", async () => {
    const expected = await readResource(c.ctx, "com.example:demo-lib-bin:1.0.0", "config/*");
    expect(jsonRun(c, ["read-resource", "com.example:demo-lib-bin:1.0.0", "config/*"])).toEqual(expected);
  });

  it("unknown artifact exits 1 with the message on stderr", () => {
    const run = cli(c, ["read-resource", "no-such-artifact", "*"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("unknown artifact");
  });
});

describe("search-symbols", () => {
  it("ranks the exact selector first with a SIGNATURE column", () => {
    const run = cli(c, ["search-symbols", "run", "--artifact", "com.example:demo-lib:1.0.0"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("SELECTOR");
    expect(run.stdout).toContain("SIGNATURE");
    expect(run.stdout.indexOf("run")).toBeGreaterThan(-1);
  });

  it("--kind field filters rows", () => {
    const run = cli(c, ["search-symbols", "NAME", "--artifact", "demo-lib", "--kind", "field"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("com.example.Demo");
  });

  it("without --artifact exits 1 with commander's one-line usage error on stderr", () => {
    const run = cli(c, ["search-symbols", "builder"]);
    expect(run.code).toBe(1);
    // commander's requiredOption miss: exactly one stderr line, no Usage block
    expect(run.stderr).toBe("error: required option '--artifact <coords>' not specified\n");
    expect(run.stdout).toBe("");
  });

  it("an unknown --artifact answers rows [] with the did-you-mean line, exit 0", () => {
    const run = cli(c, ["search-symbols", "builder", "--artifact", "demo-li"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("unknown artifact");
    expect(run.stderr).toContain("closest");
  });

  it("--json deep-equals the in-process searchSymbols result", async () => {
    const expected = await searchSymbols(c.ctx, "run", { artifact: "demo-lib", limit: 10 });
    expect(
      jsonRun(c, ["search-symbols", "run", "--artifact", "demo-lib", "--limit", "10"]),
    ).toEqual(expected);
  });
});

describe("resolve", () => {
  beforeAll(() => {
    writeFakeGradlew(resolveSuite.projectRoot, DEMO_JAR, DEMO_SOURCES_JAR);
  });

  it("re-resolves via the real cascade and prints exactly one resolved line", () => {
    const run = cli(resolveSuite, ["resolve"]);
    expect(run.code).toBe(0);
    // one line of payload: the resolve-only command reports counts, not a table
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(run.stdout).toMatch(/^resolved \d+ artifacts? in \d+ms\n$/);
    // the manifest it wrote names the resolved artifact
    const manifest = JSON.parse(
      readFileSync(join(resolveSuite.projectRoot, ".jarpeek", "manifest.json"), "utf8"),
    );
    expect(manifest.artifacts.map((a: { coordinates: string }) => a.coordinates)).toContain(
      "com.example:demo-lib:1.0.0",
    );
    // no per-artifact indexing progress ever reaches stderr
    expect(run.stderr).not.toContain("[jarpeek] indexing");
  });

  it("--json parity with in-process resolveNow except wall-clock timing", async () => {
    // both processes run the same fake gradlew over the same project
    const expected = await resolveNow(resolveSuite.ctx);
    const actual = jsonRun(resolveSuite, ["resolve"]) as Record<string, unknown> & {
      durationMs: number;
    };
    const { durationMs: _expectedMs, ...expectedRest } = expected as Record<string, unknown> & {
      durationMs: number;
    };
    const { durationMs: _actualMs, ...actualRest } = actual;
    expect(actualRest).toEqual(expectedRest);
    // demo-lib plus possibly the JDK pseudo-artifact (JAVA_HOME is an
    // environment fact); what is pinned is the parity above and the count
    // being at least the one artifact the fake gradlew reports
    expect(actual.artifactCount).toBeGreaterThanOrEqual(1);
    expect(actual.viaCacheScan).toBe(false);
    expect(actual.durationMs).toBeGreaterThanOrEqual(0);
    // the forced resolve rewrote the v2 manifest
    expect(readFileSync(join(resolveSuite.projectRoot, ".jarpeek", "manifest.json"), "utf8")).toContain(
      '"version":2',
    );
  });
});

describe("status", () => {
  it("reports manifest and jvm rows; no index rows", () => {
    const run = cli(c, ["status"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("manifest.present");
    expect(run.stdout).toContain("manifest.artifactCount");
    expect(run.stdout).toContain("jvm.available");
    expect(run.stdout).not.toContain("index.");
  });

  it("--json deep-equals the in-process status result", async () => {
    const expected = await status(c.ctx);
    const actual = jsonRun(c, ["status"]) as typeof expected;
    // the jvm probe is an environment fact; everything else must match
    expect({ ...actual, jvm: expected.jvm }).toEqual(expected);
  });
});

describe("where", () => {
  it("prints one line per recorded path with its existence", () => {
    const run = cli(c, ["where", "com.example:demo-lib:1.0.0"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("coordinates com.example:demo-lib:1.0.0");
    expect(run.stdout).toContain(`sourcesJar ${DEMO_SOURCES_JAR} (exists)`);
    expect(run.stdout.split("\n").filter((l) => /^(sourcesJar|binaryJar|sourceDir) /.test(l))).toHaveLength(1);
  });

  it("a binary-only artifact prints its single jar row", () => {
    const run = cli(c, ["where", "nosources-lib"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`binaryJar ${NOSOURCES_JAR} (exists)`);
  });

  it("--json deep-equals the in-process where result", async () => {
    const expected = await where(c.ctx, "com.example:demo-lib:1.0.0");
    expect(jsonRun(c, ["where", "com.example:demo-lib:1.0.0"])).toEqual(expected);
  });
});

describe("init", () => {
  it("--yes wires the claude mcp defaults non-interactively and exits 0", () => {
    const root = mkdtempSync(join(tmpdir(), "jarpeek-cli-init-"));
    try {
      const run = spawnSync(
        "npx",
        ["tsx", "src/cli/index.ts", "--project", root, "init", "--yes"],
        {
          cwd: PKG_ROOT,
          encoding: "utf8",
          timeout: 60_000,
          // empty JAVA_HOME keeps the JDK probe a clean no-op in any environment
          env: { ...process.env, JAVA_HOME: "" },
        },
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("non-interactive: defaults applied");
      expect(run.stdout).toContain("wired claude (mcp)");
      expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.jarpeek).toEqual({
        command: "jarpeek",
        args: ["mcp"],
      });
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".jarpeek/");
      expect(existsSync(join(root, ".jarpeek", "manifest.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prime over the CLI transport", () => {
  it("serves the cli cheatsheet, exit 0, stdout only", () => {
    const run = cli(c, ["prime"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("find-class");
    expect(run.stdout).toContain("full content: jarpeek prime --export");
    expect(run.stderr).toBe("");
  });

  it("a .jarpeek/PRIME.md override is served verbatim over the transport", () => {
    const root = mkdtempSync(join(tmpdir(), "jarpeek-cli-prime-"));
    try {
      mkdirSync(join(root, ".jarpeek"));
      writeFileSync(join(root, ".jarpeek", "PRIME.md"), "CUSTOM");
      const run = spawnSync(
        "npx",
        ["tsx", "src/cli/index.ts", "--project", root, "prime"],
        { cwd: PKG_ROOT, encoding: "utf8", timeout: 60_000 },
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe("CUSTOM\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("numeric flag validation", () => {
  it("rejects a non-integer --limit with usage on stderr and exit 1", () => {
    const run = cli(c, ["find-class", "Demo", "--limit", "abc"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/positive integer/);
    expect(run.stdout).toBe("");
  });

  it("rejects a non-positive --limit", () => {
    for (const bad of ["0", "-3"]) {
      const run = cli(c, ["find-class", "Demo", "--limit", bad]);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/positive integer/);
    }
    const symbols = cli(c, ["search-symbols", "run", "--artifact", "demo-lib", "--limit", "0"]);
    expect(symbols.code).toBe(1);
    expect(symbols.stderr).toMatch(/positive integer/);
  });

  it("rejects a 0-based or inverted --lines range", () => {
    for (const bad of ["0:5", "5:2"]) {
      const run = cli(c, ["read-source", "com.example.Demo", "--lines", bad]);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/1-based from:to/);
    }
  });

  it("valid values still work unchanged", () => {
    // v1 semantics: the simple name of `Demo$Worker` is `Worker`, so a
    // `Demo` query answers only the two Demo hits (the fuzzy tier stays
    // empty and `--limit` is never exceeded)
    const limited = cli(c, ["--json", "find-class", "Demo", "--limit", "2"]);
    expect(limited.code).toBe(0);
    const hits = JSON.parse(limited.stdout);
    expect(hits.hits.length).toBeLessThanOrEqual(2);

    const lines = cli(c, ["--json", "read-source", "com.example.Demo", "--lines", "2:4"]);
    expect(lines.code).toBe(0);
    expect(JSON.parse(lines.stdout).startLine).toBe(2);
  });
});
