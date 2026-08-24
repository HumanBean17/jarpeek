/**
 * Output-discipline contract: stderr ≤ 3 lines, stdout is the answer.
 *
 * The stderr budget is a product feature, not a nicety — v1 printed one
 * `[jarpeek] indexing` line per artifact and could spew hundreds of lines
 * into an agent's context. The contract under test: ONE bootstrap notice
 * (ctxFor's onNotice) plus at most TWO warning lines — the first warning
 * verbatim, everything after it collapsed into one
 * `warning: +N more (see: jarpeek status)` line — and a stdout whose first
 * line is always the answer, never a `[jarpeek]` prefix.
 *
 * Every scenario drives the real CLI as a subprocess (the cli.test.ts spawn
 * pattern: `npx tsx src/cli/index.ts --project <tmp root>`) against tmp
 * projects whose `gradlew` is a fake printing the sentinel dump, so the real
 * resolver cascade and the real stderr path run end to end.
 *
 * MCP parity is structural, not re-asserted here: the server's only stderr
 * writer is the same one-notice onNotice wiring (src/mcp/server.ts), and its
 * warnings ride inside the tool-result JSON where no line budget applies —
 * `warn()` exists only in the CLI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeManifest } from "../../src/index/manifest.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// PATH pinned to node's own bin for the whole file: every scenario here
// depends on the fake wrappers being the ones that run, and CI images ship a
// real Gradle that system-first selection would pick up through an inherited
// PATH (the cache-scan describe's own pin is the same idea, restated)
process.env.PATH = dirname(process.execPath);

const DEMO_JAR = join(PKG_ROOT, "test", "fixtures", "jars", "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(PKG_ROOT, "test", "fixtures", "jars", "demo-lib-1.0.0-sources.jar");

/** The two notices ctxFor can emit, pinned so a wording change is a conscious act. */
const NOTICE_FIRST_RUN = "[jarpeek] resolving dependencies (first run — may download dependencies and sources)...";
const NOTICE_STALE = "[jarpeek] resolving dependencies (manifest stale)...";

const roots: string[] = [];

/** A tmp project with a gradle marker so the real cascade engages. */
function freshProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-budget-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  roots.push(projectRoot);
  return projectRoot;
}

// the fake gradlew wrapper pair (sh + bat) lives in test/helpers
import { writeFakeGradlew, writeFailingGradlew } from "../helpers/fake-gradlew.js";

/** The suite's succeeding wrapper: the fixture jars' sentinel dump. */
const writeSucceedingGradlew = (projectRoot: string): void =>
  writeFakeGradlew(projectRoot, DEMO_JAR, DEMO_SOURCES_JAR);

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn the CLI as `node --import tsx` against one project root (the cli.test.ts mechanism). */
function cli(projectRoot: string, args: string[], env: Record<string, string> = {}): CliRun {
  const run = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli/index.ts",
    "--project",
    projectRoot,
    ...args,
  ], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", code: run.status ?? 1 };
}

/** stderr as non-empty lines — the unit the budget counts. */
function lines(stream: string): string[] {
  return stream.split("\n").filter((line) => line.length > 0);
}

/** The shared budget invariant: ≤3 lines, none of them indexing progress. */
function expectWithinBudget(run: CliRun): string[] {
  const err = lines(run.stderr);
  expect(err.length, `stderr must stay within 3 lines, got:\n${run.stderr}`).toBeLessThanOrEqual(3);
  expect(err.some((line) => line.startsWith("[jarpeek] indexing"))).toBe(false);
  return err;
}

describe("first run: the auto-resolve notice plus the warning budget", () => {
  // one project for the whole group: run 1 bootstraps (notice), run 2 serves
  // the fresh manifest (silence), run 3 asks a miss (answer, exit 0)
  const projectRoot = freshProject();

  beforeAll(() => {
    writeSucceedingGradlew(projectRoot);
  });

  it("prints the one notice line, answers on stdout, stays inside 3 stderr lines", () => {
    // JAVA_HOME empty keeps the JDK pseudo-artifact (and its warning) out of
    // the manifest deterministically on any machine
    const run = cli(projectRoot, ["find-class", "com.example.Demo"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    expect(run.stdout.startsWith("FQN")).toBe(true);
    expect(run.stdout.startsWith("[jarpeek]")).toBe(false);
    const err = expectWithinBudget(run);
    expect(err[0]).toBe(NOTICE_FIRST_RUN);
    // everything after the notice is a warning line, never progress
    expect(err.slice(1).every((line) => line.startsWith("warning: "))).toBe(true);
  });

  it("second run over the fresh manifest is silent on stderr", () => {
    const run = cli(projectRoot, ["find-class", "com.example.Demo"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    expect(run.stdout.startsWith("FQN")).toBe(true);
    expect(run.stderr).toBe("");
  });

  it("a miss query answers on stdout and exits 0", () => {
    const run = cli(projectRoot, ["find-class", "ZzzzZzzNoMatch"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    expect(run.stdout.startsWith("ZzzzZzzNoMatch")).toBe(true);
    expect(run.stdout).toContain("not found");
    expect(run.stdout.startsWith("[jarpeek]")).toBe(false);
    expectWithinBudget(run);
  });
});

describe("resolve: one line of stdout", () => {
  const projectRoot = freshProject();
  // a fake JDK home (release file + a lib/src.zip that merely exists) keeps
  // the JDK resolver's warning channel quiet — resolve never lists the zip,
  // existsSync is all it asks — so stdout is exactly the resolved line
  const jdkHome = mkdtempSync(join(tmpdir(), "jarpeek-budget-jdk-"));

  beforeAll(() => {
    writeSucceedingGradlew(projectRoot);
    writeFileSync(join(jdkHome, "release"), 'JAVA_VERSION="17.0.0"\n');
    mkdirSync(join(jdkHome, "lib"), { recursive: true });
    writeFileSync(join(jdkHome, "lib", "src.zip"), "");
    roots.push(jdkHome);
  });

  it("prints exactly one resolved line and nothing on stderr", () => {
    const run = cli(projectRoot, ["resolve"], { JAVA_HOME: jdkHome });
    expect(run.code).toBe(0);
    const out = run.stdout.replace(/\n+$/, "").split("\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^resolved \d+ artifacts? in \d+ms$/);
    expectWithinBudget(run);
  });
});

describe("resolve caps its warning lines: first 5, then one aggregate", () => {
  // the v1 line-spew's last hiding place: a cache-scan resolve on a real dev
  // machine pushes one `multiple-versions:...` warning per ambiguous g:a, so
  // `resolve` could print dozens of stdout lines. The renderer, not the
  // resolver, pays the budget: warnings are content to --json and chatter to
  // a human, and the cap lives only in the human path.
  const projectRoot = freshProject();
  const m2 = mkdtempSync(join(tmpdir(), "jarpeek-budget-m2-"));
  // the scan-root env override (the JARPEEK_HOME pattern) pins the cache scan
  // to the fake m2 tree — the real ~/.m2 would make the warning count a fact
  // about this machine, not about the command. PATH is pinned to node's own
  // bin so the gradle/mvn PATH probes MISS on every host: windows CI images
  // ship a real Gradle, and a found gradle would run instead of degrading.
  const pin = {
    JAVA_HOME: "",
    JARPEEK_M2_DIR: m2,
    JARPEEK_GRADLE_CACHE_DIR: m2,
    PATH: dirname(process.execPath),
  };

  beforeAll(() => {
    // a build.gradle marker with NO gradlew: gradle is detected, fails
    // (`no-wrapper-no-gradle`, a degraded entry on stderr), and the cascade
    // falls through to the cache scan pinned at the fake m2. 12 groups × 2
    // versions = 12 `multiple-versions` warnings (each group's sources jar
    // pairs with its kept binary, so no extra warning fires) +
    // `degraded-to-cache-scan` + the JDK resolver's `no JAVA_HOME` = 14
    // distinct warnings through the real command — 5 printed, 9 aggregated.
    for (let g = 1; g <= 12; g++) {
      for (const v of ["1.0.0", "2.0.0"]) {
        const dir = join(m2, "com", `g${g}`, "lib", v);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `lib-${v}.jar`), "");
        if (v === "2.0.0") writeFileSync(join(dir, `lib-${v}-sources.jar`), "");
      }
    }
    roots.push(m2);
  });

  // spawns the CLI against a 24-artifact m2 tree — CI runners need headroom
  // past the 30s default (timed out on a contended runner once)
  it("prints 14 warnings as 5 lines plus ONE '+9 more' aggregate", { timeout: 90_000 }, () => {
    const run = cli(projectRoot, ["resolve"], pin);
    expect(run.code).toBe(0);
    const out = lines(run.stdout);
    // 1 summary + 5 warnings + 1 aggregate — the exact line contract
    expect(out).toHaveLength(7);
    expect(out[0]).toMatch(/^resolved \d+ artifacts? in \d+ms \(14 warnings\)$/);
    expect(out[1]).toBe("degraded-to-cache-scan");
    expect(out.slice(2, 6).every((line) => line.startsWith("multiple-versions:"))).toBe(true);
    expect(out[6]).toBe("+9 more (see: jarpeek status)");
    // the hidden warnings never print verbatim: the walk visits g9..g6, so
    // the groups past the cap (g5..g1, g12..g10) stay behind the aggregate
    const printed = out.filter((line) => line.startsWith("multiple-versions:")).length;
    expect(printed).toBe(4);
    for (const g of ["g1", "g5", "g10", "g12"]) {
      expect(run.stdout).not.toContain(`multiple-versions:com.${g}:lib`);
    }
    expectWithinBudget(run);
  });

  it("--json keeps the FULL warnings array (the cap is presentation-only)", () => {
    const run = cli(projectRoot, ["--json", "resolve"], pin);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as { warnings: string[]; viaCacheScan: boolean };
    expect(parsed.viaCacheScan).toBe(true);
    expect(parsed.warnings).toHaveLength(14);
    expect(parsed.warnings[0]).toBe("degraded-to-cache-scan");
    expect(parsed.warnings.filter((w) => w.startsWith("multiple-versions:"))).toHaveLength(12);
  });
});

describe("more than two warnings collapse into one aggregate line", () => {
  const projectRoot = freshProject();

  beforeAll(async () => {
    // the combination that honestly exceeds the budget through ONE
    // invocation: a stale manifest (hash that matches nothing) forces a
    // bootstrap, the failing gradlew adds its degradation, and the cache-scan
    // fallback makes the bootstrap serve the manifest stale — then the query
    // itself contributes `stale index served` and one unreadable artifact
    writeFailingGradlew(projectRoot, "kaboom");
    await writeManifest(projectRoot, {
      version: 2,
      resolvedAt: new Date().toISOString(),
      dependencySetHash: "not-the-current-hash",
      artifacts: [
        {
          coordinates: "com.example:demo-lib:1.0.0",
          kind: "external",
          sourcesJar: DEMO_SOURCES_JAR,
        },
        {
          coordinates: "com.example:broken:1.0.0",
          kind: "external",
          binaryJar: join(projectRoot, "vanished.jar"),
        },
      ],
    });
  });

  it("prints the first warning verbatim then +N more, three stderr lines total", () => {
    const run = cli(projectRoot, ["find-class", "com.example.Demo"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    // the hit must exist: the hit path is the one that carries the warnings
    expect(run.stdout.startsWith("FQN")).toBe(true);
    // degraded set, in order: gradle failure, stale-served-cache-scan (both
    // from the bootstrap), stale index served, one unreadable artifact (both
    // from the query) — four distinct warnings, one shown verbatim
    expect(lines(run.stderr)).toEqual([
      NOTICE_STALE,
      "warning: gradle: gradle-failed:kaboom",
      "warning: +3 more (see: jarpeek status)",
    ]);
    expectWithinBudget(run);
  });
});

describe("a failed auto-resolve answers the miss with its reason (spec decision #1)", () => {
  // fresh project + failing build: the bootstrap fails (no manifest to serve
  // stale), the query answers as a miss, and the miss must carry the reason
  // on stderr — not just in the JSON object where the agent never looks
  const projectRoot = freshProject();

  beforeAll(() => {
    writeFailingGradlew(projectRoot, "resolve-me-not");
  });

  it("prints the failure warning after the notice, the miss on stdout, exit 0", () => {
    const run = cli(projectRoot, ["find-class", "ZzzzZzzNoMatch"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    // stdout is still the miss answer, never the warning
    expect(run.stdout.startsWith("ZzzzZzzNoMatch")).toBe(true);
    expect(run.stdout).toContain("not found");
    // the warnings the bootstrap collected: the gradle failure, the cache-scan
    // fallback — first verbatim, the rest collapsed; all inside the budget
    const err = expectWithinBudget(run);
    expect(err[0]).toBe(NOTICE_FIRST_RUN);
    expect(err.slice(1).every((line) => line.startsWith("warning: "))).toBe(true);
    expect(run.stderr).toContain("warning: gradle: gradle-failed:resolve-me-not");
    expect(run.stderr).toContain("warning: +1 more (see: jarpeek status)");
  });

  it("--json carries degraded on the negative object", () => {
    const run = cli(projectRoot, ["--json", "find-class", "ZzzzZzzNoMatch"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      found: boolean;
      via: string;
      degraded?: string[];
    };
    expect(parsed.found).toBe(false);
    expect(parsed.via).toBe("negative");
    expect(parsed.degraded).toContain("resolution failed: degraded to cache-scan; run jarpeek resolve");
  });
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
