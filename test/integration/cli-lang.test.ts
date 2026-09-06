/**
 * The ru locale over the real CLI: runtime strings (warnings, miss
 * answers, usage errors, unknown-command suggestions) localize through
 * `--lang ru` while core-produced diagnostics (the `[jarpeek]` notice,
 * resolver degradation texts, miss notes/reasons) stay English — the
 * human/contract boundary the i18n spec locks. The suite bootstraps tmp
 * projects in-process (the cli.test.ts pattern) so subprocesses serve a
 * fresh manifest; the warn-budget group pins the cache scan to a fake m2
 * (the output-budget.test.ts pattern) so warning counts are facts about
 * the fixtures, not the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext, type QueryContext } from "../../src/core/query/context.js";
import type { DependencyArtifact } from "../../src/core/types.js";
import { writeFakeGradlew } from "../helpers/fake-gradlew.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Strategy pinned to wrapper for the whole file — subprocesses inherit it
// and the in-process suites converge it — so the fake wrappers are the only
// candidates on every host (CI images ship a real system Gradle).
process.env.JARPEEK_BUILD_TOOL = "wrapper";

const JARS = join(PKG_ROOT, "test", "fixtures", "jars");
const DEMO_JAR = join(JARS, "demo-lib-1.0.0.jar");
const DEMO_SOURCES_JAR = join(JARS, "demo-lib-1.0.0-sources.jar");

interface Suite {
  projectRoot: string;
  ctx: QueryContext;
}

const suites: Suite[] = [];
const roots: string[] = [];

/** A project whose gradle resolver always answers the given artifact set. */
function openSuite(artifacts: DependencyArtifact[]): Suite {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-lang-project-"));
  writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
  roots.push(projectRoot);
  const ctx = openContext(projectRoot, {
    resolvers: { gradle: async () => ({ ok: true, artifacts }), includeJdk: false },
  });
  const suite = { projectRoot, ctx };
  suites.push(suite);
  return suite;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/** Spawn the CLI as `node --import tsx` with `--project` at a bootstrapped root. */
function cli(projectRoot: string, args: string[], env: Record<string, string> = {}): CliRun {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli/index.ts", "--project", projectRoot, ...args],
    { cwd: PKG_ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 },
  );
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", code: run.status ?? 1 };
}

const DEMO_ARTIFACTS: DependencyArtifact[] = [
  { coordinates: "com.example:demo-lib:1.0.0", kind: "external", sourcesJar: DEMO_SOURCES_JAR },
];

describe("miss answers", () => {
  const suite = {} as Suite;

  beforeAll(async () => {
    Object.assign(suite, openSuite(DEMO_ARTIFACTS));
    await suite.ctx.ensureReady();
  });

  it("a fuzzy miss suggests in russian", () => {
    // "Dmo" is a subsequence of Demo: the suggestion ladder finds what was meant
    const run = cli(suite.projectRoot, ["--lang", "ru", "outline", "com.example.Dmo"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("возможно, вы имели в виду:");
    expect(run.stdout).not.toContain("did you mean:");
    expect(run.stdout).toContain("com.example.Demo"); // the suggestion payload
  });

  it("a negative miss labels the searched set in russian", () => {
    const run = cli(suite.projectRoot, ["--lang", "ru", "find-class", "ZzzzZzzNoMatch"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("просмотрено:");
    expect(run.stdout).not.toContain("searched:");
    expect(run.stdout).toContain("com.example:demo-lib:1.0.0"); // verbatim coords
  });

  it("an empty manifest renders the ru none-marker", () => {
    const empty = {} as Suite;
    Object.assign(empty, openSuite([]));
    void empty.ctx.ensureReady(); // bootstrap before the subprocess asks
    const run = cli(empty.projectRoot, ["--lang", "ru", "find-class", "ZzzzZzzNoMatch"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("(нет)");
  });

  it("the trailing --lang flag localizes the same output", () => {
    const run = cli(suite.projectRoot, ["find-class", "ZzzzZzzNoMatch", "--lang", "ru"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("просмотрено:");
  });

  it("without --lang the en strings stand (regression oracle)", () => {
    const run = cli(suite.projectRoot, ["find-class", "ZzzzZzzNoMatch"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("searched:");
    expect(run.stdout).toContain("not found in resolved artifacts");
  });
});

describe("usage errors", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-lang-err-"));
  roots.push(projectRoot);

  it("--lines rejects a malformed range in russian", () => {
    const run = cli(projectRoot, ["--lang", "ru", "read-source", "com.example.Demo", "--lines", "bad"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--lines");
    expect(run.stderr).toContain("получено");
    expect(run.stderr).not.toContain("expects from:to");
  });

  it("mutually exclusive presets report in russian", () => {
    const run = cli(projectRoot, ["--lang", "ru", "outline", "com.example.Demo", "--minimal", "--full"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("взаимоисключающие");
    expect(run.stderr).not.toContain("mutually exclusive");
  });

  it("an unknown command suggests in russian", () => {
    // "find-clas" is a subsequence of find-class: the fuzzy ladder finds it
    const run = cli(projectRoot, ["--lang", "ru", "find-clas"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("неизвестная команда 'find-clas'");
    expect(run.stderr).toContain("'find-class'");
    expect(run.stderr).not.toContain("unknown command");
  });
});

describe("result renderers (ru)", () => {
  const suite = {} as Suite;

  beforeAll(async () => {
    Object.assign(suite, openSuite(DEMO_ARTIFACTS));
    await suite.ctx.ensureReady();
  });

  it("read-member localizes the span and provenance labels", () => {
    const run = cli(suite.projectRoot, ["--lang", "ru", "read-member", "com.example.Demo", "#run(String,int)"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/строки \d+–\d+/);
    expect(run.stdout).toContain("происхождение");
    expect(run.stdout).not.toMatch(/lines \d+–\d+/);
  });

  it("a member miss labels in ru, the reason stays core-en", () => {
    const run = cli(suite.projectRoot, [
      "--lang",
      "ru",
      "read-member",
      "com.example.Demo",
      "#run",
      "#nosuch()",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("не найдено #nosuch():");
  });

  it("read-source --lines speaks ru for header and range", () => {
    const run = cli(suite.projectRoot, ["--lang", "ru", "read-source", "com.example.Demo", "--lines", "2:3"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("файл ");
    expect(run.stdout).toContain("строки 2–3 из");
    expect(run.stdout).not.toContain("provenance");
  });

  it("read-source --full renders the ru full-range header", () => {
    const run = cli(suite.projectRoot, ["--lang", "ru", "read-source", "com.example.Demo", "--full"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/строки 1-\d+/);
  });

  it("read-resource reports no matches in ru", () => {
    const run = cli(suite.projectRoot, [
      "--lang",
      "ru",
      "read-resource",
      "com.example:demo-lib:1.0.0",
      "NO/SUCH/**",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("нет подходящих записей");
    expect(run.stdout).toContain("происхождение");
  });

  it("search-symbols with no hits answers in ru", () => {
    const run = cli(suite.projectRoot, [
      "--lang",
      "ru",
      "search-symbols",
      "zzznope",
      "--artifact",
      "demo-lib",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("символы по запросу zzznope не найдены");
  });

  it("where renders coordinates and existence in ru", () => {
    const run = cli(suite.projectRoot, ["--lang", "ru", "where", "com.example:demo-lib:1.0.0"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("координаты com.example:demo-lib:1.0.0");
    expect(run.stdout).toContain("(существует)");
    expect(run.stdout).not.toContain("(exists)");
  });
});

describe("init (ru)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-lang-init-"));
  roots.push(projectRoot);

  it("the report labels localize", () => {
    const run = cli(projectRoot, ["--lang", "ru", "init", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("системы сборки:");
    expect(run.stdout).toContain("(нет)");
    expect(run.stdout).toContain("jdk:");
  });
});

describe("the warning channel", () => {
  // build.gradle with no wrapper (strategy pinned to wrapper above): gradle
  // degrades, the cascade falls through to a cache scan pinned at a fake m2
  // with 3 two-version groups — 3 multiple-versions warnings plus the
  // degradation entries, so the ru aggregate line and its plural both fire.
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-lang-warn-"));
  const m2 = mkdtempSync(join(tmpdir(), "jarpeek-lang-m2-"));
  roots.push(projectRoot, m2);
  const pin = { JAVA_HOME: "", JARPEEK_M2_DIR: m2, JARPEEK_GRADLE_CACHE_DIR: m2 };

  beforeAll(() => {
    writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
    for (let g = 1; g <= 3; g++) {
      for (const v of ["1.0.0", "2.0.0"]) {
        const dir = join(m2, "com", `g${g}`, "lib", v);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `lib-${v}.jar`), "");
        if (v === "2.0.0") writeFileSync(join(dir, `lib-${v}-sources.jar`), "");
      }
    }
  });

  it("warnings render under the ru prefix, the resolved line takes the few plural", () => {
    const run = cli(projectRoot, ["--lang", "ru", "resolve"], pin);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("предупреждение: ");
    expect(run.stderr).not.toContain("warning: ");
    // 3 kept artifacts is the "few" plural; core warnings stay en
    expect(run.stdout).toMatch(/^разрешено 3 артефакта за \d+ мс/);
    expect(run.stdout).not.toContain("resolved");
  });

  it("the en prefix stands without --lang", () => {
    const run = cli(projectRoot, ["resolve"], pin);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("warning: ");
  });
});

describe("resolve line plural (one)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-lang-one-"));
  roots.push(projectRoot);

  beforeAll(() => {
    writeFileSync(join(projectRoot, "build.gradle"), "plugins { id 'java' }\n");
    writeFakeGradlew(projectRoot, DEMO_JAR, DEMO_SOURCES_JAR);
  });

  it("one artifact takes the ru one-form", () => {
    const run = cli(projectRoot, ["--lang", "ru", "resolve"], { JAVA_HOME: "" });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^разрешен 1 артефакт за \d+ мс/);
    expect(run.stdout).not.toContain("resolved");
  });
});
