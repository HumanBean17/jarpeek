import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SpawnError,
  TimeoutError,
  runWithTimeout,
  type RunOptions,
  type RunResult,
} from "../../src/util/exec.js";
import { GRADLE_INIT_SCRIPT, ensureGradleInitScript } from "../../src/resolver/gradle-init.js";
import { gradleOnPathDefault, resolveGradle } from "../../src/resolver/gradle.js";
import { moduleCoordinates, moduleNamespace } from "../../src/resolver/module-coordinate.js";

/** Always-true PATH probe; installed by tests that reach the bare-gradle path. */
const PROBE_FOUND = () => true;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SAMPLE_OUTPUT = readFileSync(join(FIXTURES, "gradle", "sample-output.txt"), "utf8");

// coordinates and paths mirrored from sample-output.txt
const SPRING_TX = "org.springframework:spring-tx:6.1.4";
const SPRING_TX_JAR =
  "/home/dev/.gradle/caches/modules-2/files-2.1/org.springframework/spring-tx/6.1.4/1a2b3c4d/spring-tx-6.1.4.jar";
const SPRING_TX_SOURCES =
  "/home/dev/.gradle/caches/modules-2/files-2.1/org.springframework/spring-tx/6.1.4/5e6f7a8b/spring-tx-6.1.4-sources.jar";
const SLF4J = "org.slf4j:slf4j-api:2.0.13";
const SLF4J_JAR =
  "/home/dev/.gradle/caches/modules-2/files-2.1/org.slf4j/slf4j-api/2.0.13/9c0d1e2f/slf4j-api-2.0.13.jar";
const JUNIT = "org.junit.jupiter:junit-jupiter:5.10.2";
const JUNIT_JAR =
  "/home/dev/.gradle/caches/modules-2/files-2.1/org.junit.jupiter/junit-jupiter/5.10.2/3a4b5c6d/junit-jupiter-5.10.2.jar";
const APP_DIR = "/home/dev/work/demo/app";

/** The pinned gradle arguments after the command itself (init script, console, cc-off, task). */
const INIT_ARGS = (projectRoot: string) => [
  "-I",
  join(projectRoot, ".jarpeek", "gradle-init.gradle"),
  "--console=plain",
  "-q",
  "--no-configuration-cache",
  "jarpeekDump",
];

const realPlatform = process.platform;
let root: string | undefined;

/** Fresh scratch project root (cleaned in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-gradle-"));
  return root;
}

function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true, configurable: true });
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  stubPlatform(realPlatform);
});

interface ExecCall {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

/** exec stub recording every invocation, delegating to `impl` for the result. */
function stubExec(
  impl: (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>,
): { exec: typeof runWithTimeout; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    return impl(cmd, args, opts);
  };
  return { exec, calls };
}

/** exec stub resolving a fixed stdout (plus optional stderr/code; null code preserved). */
function outputExec(
  stdout: string,
  result: Pick<RunResult, "stderr" | "code"> = {},
): { exec: typeof runWithTimeout; calls: ExecCall[] } {
  const code = result.code === undefined ? 0 : result.code;
  return stubExec(async () => ({ stdout, stderr: result.stderr ?? "", code }));
}

/** coordinates → artifact lookup that fails loudly on a missing entry. */
function indexBy(artifacts: Array<{ coordinates: string }>) {
  const index = new Map(artifacts.map((a) => [a.coordinates, a]));
  return (coordinates: string) => {
    const hit = index.get(coordinates);
    if (hit === undefined) throw new Error(`missing artifact for ${coordinates}`);
    return hit;
  };
}

describe("resolveGradle: parsing the sentinel-wrapped dump", () => {
  it("maps the sample dump to external artifacts (with and without sources), a module artifact, and skips the errored configuration", async () => {
    const projectRoot = scratch();
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(resolution.reason).toBeUndefined();
    expect(resolution.artifacts).toHaveLength(4); // annotationProcessor errored → nothing

    const lookup = indexBy(resolution.artifacts);

    const springTx = lookup(SPRING_TX);
    expect(springTx.kind).toBe("external");
    expect(springTx.configuration).toBe("compile");
    expect(springTx.binaryJar).toBe(SPRING_TX_JAR);
    expect(springTx.sourcesJar).toBe(SPRING_TX_SOURCES);
    // exact shape: the legacy per-artifact metadata fields no longer exist
    expect(Object.keys(springTx).sort()).toEqual(["binaryJar", "configuration", "coordinates", "kind", "sourcesJar"]);

    const slf4j = lookup(SLF4J);
    expect(slf4j.kind).toBe("external");
    expect(slf4j.configuration).toBe("compile");
    expect(slf4j.binaryJar).toBe(SLF4J_JAR);
    expect(slf4j.sourcesJar).toBeUndefined();

    const junit = lookup(JUNIT);
    expect(junit.kind).toBe("external");
    expect(junit.configuration).toBe("test");
    expect(junit.binaryJar).toBe(JUNIT_JAR);
    expect(junit.provenance).toBeUndefined();

    // module coordinates are namespaced per project root: the bare project
    // path (":app") would collide with another project's ":app" in the
    // user-global index cache
    const app = lookup(moduleCoordinates(projectRoot, ":app"));
    expect(app.coordinates).toBe(`module:${moduleNamespace(projectRoot)}:app`);
    expect(app.kind).toBe("module");
    expect(app.sourceDir).toBe(APP_DIR);
    expect(app.provenance).toBeUndefined();
    expect(app.warnings).toBeUndefined();

    // invocation shape: bare gradle (no wrapper in scratch, probe passed),
    // pinned args, cwd, default timeout. win32 routes bare gradle through
    // `cmd /c`, so both platforms' shapes normalize to the effective command.
    expect(calls).toHaveLength(1);
    const effective =
      calls[0].cmd === "cmd" && calls[0].args[0] === "/c"
        ? { cmd: calls[0].args[1], args: calls[0].args.slice(2) }
        : { cmd: calls[0].cmd, args: calls[0].args };
    expect(effective.cmd).toBe("gradle");
    expect(effective.args).toEqual(INIT_ARGS(projectRoot));
    expect(calls[0].opts.cwd).toBe(projectRoot);
    expect(calls[0].opts.timeoutMs).toBe(180_000);
  });

  it("dedupes by coordinates with the first configuration winning, and maps kapt* to annotationProcessor", async () => {
    const projectRoot = scratch();
    const doc = {
      configurations: [
        {
          name: "compileClasspath",
          dependencies: [{ coordinates: "com.example:lib:1.0", kind: "external", path: "/c/lib-1.0.jar" }],
        },
        {
          name: "runtimeClasspath",
          dependencies: [{ coordinates: "com.example:lib:1.0", kind: "external", path: "/c/lib-1.0.jar" }],
        },
        {
          name: "kaptTest",
          dependencies: [
            { coordinates: "com.example:proc:2.0", kind: "external", path: "/c/proc-2.0.jar" },
          ],
        },
      ],
      sources: {},
    };
    const stdout = `###JARPEEK-BEGIN###\n${JSON.stringify(doc)}\n###JARPEEK-END###\n`;
    const { exec } = outputExec(stdout);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(2);
    const lib = resolution.artifacts.find((a) => a.coordinates === "com.example:lib:1.0")!;
    expect(lib.configuration).toBe("compile");
    const proc = resolution.artifacts.find((a) => a.coordinates === "com.example:proc:2.0")!;
    expect(proc.configuration).toBe("annotationProcessor");
  });
});

describe("resolveGradle: failure and degradation reasons", () => {
  it("reports timeout when exec rejects with TimeoutError", async () => {
    const projectRoot = scratch();
    const { exec } = stubExec(() => Promise.reject(new TimeoutError("gradle", 180_000)));

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "timeout" });
  });

  it("reports gradle-failed:<stderr tail> on non-zero exit, trimming long stderr", async () => {
    const projectRoot = scratch();

    const boom = await resolveGradle(projectRoot, {
      exec: outputExec(SAMPLE_OUTPUT, { code: 1, stderr: "boom" }).exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(boom.ok).toBe(false);
    expect(boom.reason).toBe("gradle-failed:boom");

    const longStderr = await resolveGradle(projectRoot, {
      exec: outputExec("", { code: 1, stderr: "x".repeat(600) + "boom" }).exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(longStderr.reason).toBe(`gradle-failed:${"x".repeat(496)}boom`);
  });

  it("never yields an empty reason: empty stderr falls back to stdout, then an exit marker", async () => {
    const projectRoot = scratch();

    const quietStdout = await resolveGradle(projectRoot, {
      exec: outputExec("[ERROR] compilation failed", { code: 1 }).exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(quietStdout.ok).toBe(false);
    expect(quietStdout.reason).toBe("gradle-failed:[ERROR] compilation failed");

    const fullyQuiet = await resolveGradle(projectRoot, {
      exec: outputExec("", { code: 1 }).exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(fullyQuiet.reason).toBe("gradle-failed:exit 1 (no output)");
  });

  it("marks a killed process (code null) when stderr is empty", async () => {
    const projectRoot = scratch();

    const killed = await resolveGradle(projectRoot, {
      exec: outputExec("", { code: null }).exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(killed.reason).toBe("gradle-failed:(killed)");

    const killedWithStderr = await resolveGradle(projectRoot, {
      exec: outputExec("", { code: null, stderr: "SIGSEGV" }).exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(killedWithStderr.reason).toBe("gradle-failed:SIGSEGV");
  });

  it("reports no-output when stdout carries no sentinels", async () => {
    const projectRoot = scratch();
    const resolution = await resolveGradle(projectRoot, {
      exec: outputExec("BUILD SUCCESSFUL in 2s\n").exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-output" });
  });

  it("reports bad-json when the payload between sentinels does not parse", async () => {
    const projectRoot = scratch();
    const resolution = await resolveGradle(projectRoot, {
      exec: outputExec("###JARPEEK-BEGIN###\nnot json {{\n###JARPEEK-END###\n").exec,
      gradleOnPath: PROBE_FOUND,
    });
    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "bad-json" });
  });
});

describe("resolveGradle: wrapper selection", () => {
  it("uses <root>/gradlew on non-win32 platforms", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeFileSync(join(projectRoot, "gradlew"), "#!/bin/sh\n");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    // probe pinned off: a system gradle would win the auto order before the wrapper
    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: () => false });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe(join(projectRoot, "gradlew"));
    expect(calls[0].args).toEqual(INIT_ARGS(projectRoot));
    expect(calls[0].opts.cwd).toBe(projectRoot);
  });

  it("spawns gradlew.bat via cmd /c on win32", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    writeFileSync(join(projectRoot, "gradlew.bat"), "@echo off\r\n");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    // probe pinned off: a system gradle would win the auto order before the wrapper
    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: () => false });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args.slice(0, 2)).toEqual(["/c", join(projectRoot, "gradlew.bat")]);
    expect(calls[0].args.slice(2)).toEqual(INIT_ARGS(projectRoot));
  });

  it("falls back to bare gradle when no wrapper exists", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("gradle");
    expect(calls[0].args).toEqual(INIT_ARGS(projectRoot));
  });

  it("reports gradle-failed:<spawn error> when bare gradle fails to spawn despite a passing probe", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const cause = Object.assign(new Error("spawn gradle ENOENT"), { code: "ENOENT" });
    const { exec } = stubExec(() => Promise.reject(new SpawnError("gradle", cause)));

    // probe passed, so the spawn itself is the first failure seen — a spawn
    // failure is an attempt failure, not absence
    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: 'gradle-failed:failed to spawn "gradle": spawn gradle ENOENT',
    });
  });

  it("reports gradle-failed when an existing wrapper fails to spawn", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeFileSync(join(projectRoot, "gradlew"), "#!/bin/sh\n");
    const cause = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const { exec } = stubExec(() =>
      Promise.reject(new SpawnError(join(projectRoot, "gradlew"), cause)),
    );

    // probe pinned off so the wrapper is the only candidate
    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: () => false });

    expect(resolution.ok).toBe(false);
    expect(resolution.reason?.startsWith("gradle-failed:")).toBe(true);
  });

  it("uses an explicitly provided wrapper command verbatim", async () => {
    const projectRoot = scratch();
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, wrapper: "/opt/gradle/bin/gradle" });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("/opt/gradle/bin/gradle");
    expect(calls[0].args).toEqual(INIT_ARGS(projectRoot));
  });
});

describe("resolveGradle: bare-gradle PATH probe", () => {
  it("reports no-wrapper-no-gradle on win32 when no wrapper and no gradle is on PATH", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: () => false });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-wrapper-no-gradle" });
    expect(calls).toHaveLength(0); // probed, never spawned
  });

  it("spawns bare gradle via cmd on win32 when gradle.bat is on PATH", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args).toEqual(["/c", "gradle", ...INIT_ARGS(projectRoot)]);
    expect(calls[0].opts.cwd).toBe(projectRoot);
  });

  it("reports no-wrapper-no-gradle on unix when the probe finds no gradle", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: () => false });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-wrapper-no-gradle" });
    expect(calls).toHaveLength(0);
  });
});

describe("resolveGradle: build-tool strategy", () => {
  /** Executable root wrapper (unix shape). */
  function writeGradlew(projectRoot: string): void {
    const path = join(projectRoot, "gradlew");
    writeFileSync(path, "#!/bin/sh\n");
  }

  /**
   * exec stub where the SYSTEM command's run fails with `fail` and the
   * wrapper's succeeds with SAMPLE_OUTPUT (identified by command shape, so
   * both unix and win32 routing work).
   */
  function systemFailsWrapperSucceeds(isSystem: (cmd: string, args: string[]) => boolean) {
    return stubExec(async (cmd, args) =>
      isSystem(cmd, args)
        ? { stdout: "", stderr: "sysboom", code: 1 }
        : { stdout: SAMPLE_OUTPUT, stderr: "", code: 0 },
    );
  }

  it("auto prefers the system gradle when the probe passes and a wrapper exists", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("gradle");
    expect(calls[0].args).toEqual(INIT_ARGS(projectRoot));
  });

  it("auto uses the wrapper alone when the probe finds no system gradle", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: () => false });

    expect(resolution.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(join(projectRoot, "gradlew"));
  });

  it("auto retries with the wrapper after a failed system run", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = systemFailsWrapperSucceeds((cmd) => cmd === "gradle");

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["gradle", join(projectRoot, "gradlew")]);
  });

  it("auto combines both attempts' details when every candidate fails", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec } = stubExec(async (cmd) => ({
      stdout: "",
      stderr: cmd === "gradle" ? "sysboom" : "wrapboom",
      code: 1,
    }));

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: "gradle-failed:system: sysboom | wrapper: wrapboom",
    });
  });

  it("strategy system runs only the system gradle even with a wrapper present", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, {
      exec,
      gradleOnPath: PROBE_FOUND,
      strategy: "system",
    });

    expect(resolution.ok).toBe(true);
    expect(calls.every((c) => c.cmd === "gradle")).toBe(true);
  });

  it("strategy system with a failing probe reports no-wrapper-no-gradle without spawning", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, {
      exec,
      gradleOnPath: () => false,
      strategy: "system",
    });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-wrapper-no-gradle" });
    expect(calls).toHaveLength(0);
  });

  it("strategy wrapper runs only the wrapper even with a system gradle present", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, {
      exec,
      gradleOnPath: PROBE_FOUND,
      strategy: "wrapper",
    });

    expect(resolution.ok).toBe(true);
    expect(calls.every((c) => c.cmd === join(projectRoot, "gradlew"))).toBe(true);
  });

  it("strategy wrapper with no wrapper file reports no-wrapper without spawning", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, {
      exec,
      gradleOnPath: PROBE_FOUND,
      strategy: "wrapper",
    });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-wrapper" });
    expect(calls).toHaveLength(0);
  });

  it("an explicit wrapper command bypasses the strategy entirely", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeGradlew(projectRoot);
    const { exec, calls } = outputExec(SAMPLE_OUTPUT);

    const resolution = await resolveGradle(projectRoot, {
      exec,
      gradleOnPath: PROBE_FOUND,
      wrapper: "/opt/gradle/bin/gradle",
      strategy: "system",
    });

    expect(resolution.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("/opt/gradle/bin/gradle");
  });

  it("win32 auto: system first via cmd /c gradle, wrapper retry via cmd /c gradlew.bat", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    writeFileSync(join(projectRoot, "gradlew.bat"), "@echo off\r\n");
    const { exec, calls } = systemFailsWrapperSucceeds(
      (cmd, args) => cmd === "cmd" && args[1] === "gradle",
    );

    const resolution = await resolveGradle(projectRoot, { exec, gradleOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args.slice(0, 2)).toEqual(["/c", "gradle"]);
    expect(calls[1].cmd).toBe("cmd");
    expect(calls[1].args.slice(0, 2)).toEqual(["/c", join(projectRoot, "gradlew.bat")]);
  });
});

describe("gradleOnPathDefault", () => {
  const realPath = process.env.PATH;
  const realPathExt = process.env.PATHEXT;

  afterEach(() => {
    process.env.PATH = realPath;
    if (realPathExt !== undefined) process.env.PATHEXT = realPathExt;
    else delete process.env.PATHEXT;
    stubPlatform(realPlatform);
  });

  it("finds an executable gradle on a unix PATH and misses without one", () => {
    const projectRoot = scratch();
    const withGradle = join(projectRoot, "with-gradle");
    const withoutGradle = join(projectRoot, "without-gradle");
    mkdirSync(withGradle);
    mkdirSync(withoutGradle);
    writeFileSync(join(withGradle, "gradle"), "#!/bin/sh\n");
    chmodSync(join(withGradle, "gradle"), 0o755);
    stubPlatform("darwin");

    process.env.PATH = withGradle;
    expect(gradleOnPathDefault()).toBe(true);

    process.env.PATH = withoutGradle;
    expect(gradleOnPathDefault()).toBe(false);
  });

  it("matches gradle.bat via PATHEXT on win32 and misses without one", () => {
    const projectRoot = scratch();
    const bin = join(projectRoot, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gradle.bat"), "@echo off\r\n");
    stubPlatform("win32");
    delete process.env.PATHEXT; // default extension list covers .bat

    process.env.PATH = bin;
    expect(gradleOnPathDefault()).toBe(true);

    rmSync(join(bin, "gradle.bat"));
    expect(gradleOnPathDefault()).toBe(false);
  });
});

describe("ensureGradleInitScript", () => {
  it("writes .jarpeek/gradle-init.gradle and rewrites nothing on identical content", async () => {
    const projectRoot = scratch();

    const first = await ensureGradleInitScript(projectRoot);
    expect(first).toBe(join(projectRoot, ".jarpeek", "gradle-init.gradle"));
    expect(readFileSync(first, "utf8")).toBe(GRADLE_INIT_SCRIPT);

    const mtimeBefore = statSync(first).mtimeMs;
    const second = await ensureGradleInitScript(projectRoot);
    expect(second).toBe(first);
    expect(readFileSync(second, "utf8")).toBe(GRADLE_INIT_SCRIPT);
    expect(statSync(first).mtimeMs).toBe(mtimeBefore); // no rewrite when content matches

    // a tampered file is restored
    await writeFile(first, "// tampered", "utf8");
    const restored = await ensureGradleInitScript(projectRoot);
    expect(restored).toBe(first);
    expect(readFileSync(restored, "utf8")).toBe(GRADLE_INIT_SCRIPT);
  });
});

describe("GRADLE_INIT_SCRIPT", () => {
  it("pins the Groovy contract: one jarpeekDump task printing sentinel-wrapped JSON", () => {
    expect(GRADLE_INIT_SCRIPT).toContain("jarpeekDump");
    expect(GRADLE_INIT_SCRIPT).toContain("###JARPEEK-BEGIN###");
    expect(GRADLE_INIT_SCRIPT).toContain("###JARPEEK-END###");
    expect(GRADLE_INIT_SCRIPT).toContain("JsonOutput.toJson");
    expect(GRADLE_INIT_SCRIPT).toContain("compileClasspath");
    expect(GRADLE_INIT_SCRIPT).toContain("testRuntimeClasspath");
    expect(GRADLE_INIT_SCRIPT).toContain("kaptTest");
    expect(GRADLE_INIT_SCRIPT).toContain("failure.message ?:"); // null message → class name, not "null"
  });
});
