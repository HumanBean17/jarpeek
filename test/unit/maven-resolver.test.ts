import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SpawnError,
  TimeoutError,
  runWithTimeout,
  type RunOptions,
  type RunResult,
} from "../../src/util/exec.js";
import { mvnOnPathDefault, resolveMaven } from "../../src/resolver/maven.js";
import { moduleCoordinates } from "../../src/resolver/module-coordinate.js";

/** Always-true PATH probe; installed by tests that reach the bare-mvn path. */
const PROBE_FOUND = () => true;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const CP_UNIX = readFileSync(join(FIXTURES, "maven", "cp-unix.txt"), "utf8");
const CP_WINDOWS = readFileSync(join(FIXTURES, "maven", "cp-windows.txt"), "utf8");

// coordinates mirrored from the fixtures
const SPRING_TX = "org.springframework:spring-tx:6.1.4";
const JUNIT = "org.junit.jupiter:junit-jupiter:5.10.2";
const LIB = "com.example:lib:2.0"; // synthesized per-test via m2Jar

const realPlatform = process.platform;
let root: string | undefined;

/** Fresh scratch project root (cleaned in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-maven-"));
  return root;
}

function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true, configurable: true });
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  stubPlatform(realPlatform);
  vi.unstubAllEnvs();
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

/** coordinates → artifact lookup that fails loudly on a missing entry. */
function indexBy(artifacts: Array<{ coordinates: string }>) {
  const index = new Map(artifacts.map((a) => [a.coordinates, a]));
  return (coordinates: string) => {
    const hit = index.get(coordinates);
    if (hit === undefined) throw new Error(`missing artifact for ${coordinates}`);
    return hit;
  };
}

/** Repository-relative part of a fixture jar path (`org/a/b/1.0/b-1.0.jar`). */
function relFromFixture(path: string): string {
  return path.slice(path.indexOf("repository") + "repository".length + 1);
}

/**
 * Materialize a fixture cp.txt onto a synthetic m2 repository root: every
 * `…/repository/<rel>` jar becomes a real file under `m2/<rel>`, with a
 * `-sources.jar` sibling for entries listed in `sources`. Entries are
 * re-joined with the host's classpath delimiter — real mvn writes
 * `;`-joined output on win32, `:`-joined on unix — so the resolver sees
 * the shape this platform's mvn would have produced, with only the m2
 * base swapped.
 */
function materialize(m2: string, cp: string, sources: string[]): { content: string; jars: string[] } {
  const jars: string[] = [];
  const sourcesRel = new Set(sources.map(relFromFixture));
  const content = cp
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/[;:](?=[A-Za-z]:|\/)/)
        .map((raw) => {
          if (!raw.endsWith(".jar") || !raw.includes("repository")) return raw;
          const rel = relFromFixture(raw);
          const jar = join(m2, ...rel.split(/[\\/]/));
          mkdirSync(dirname(jar), { recursive: true });
          writeFileSync(jar, "jar");
          jars.push(jar);
          if (sourcesRel.has(rel)) {
            writeFileSync(`${jar.slice(0, -".jar".length)}-sources.jar`, "sources");
          }
          return jar;
        })
        .join(delimiter),
    )
    .join("\n");
  return { content, jars };
}

/**
 * The effective mvn invocation behind a recorded call: win32 routes bare
 * mvn through `cmd /c`, so both platforms' shapes normalize to one. (The
 * stubbed-win32 tests assert the raw wrapper shape directly instead.)
 */
function effectiveMvn(call: ExecCall): { cmd: string; args: string[] } {
  if (call.cmd === "cmd" && call.args[0] === "/c") {
    return { cmd: call.args[1], args: call.args.slice(2) };
  }
  return { cmd: call.cmd, args: call.args };
}

/** Path of a jar directly under the synthetic m2 root (no fixture indirection). */
function m2Jar(m2: string, ...rel: string[]): string {
  const jar = join(m2, ...rel);
  mkdirSync(dirname(jar), { recursive: true });
  writeFileSync(jar, "jar");
  return jar;
}

/**
 * exec stub mimicking the reactor-wide build-classpath run: the goal's
 * RELATIVE `-Dmdep.outputFile` resolves against each module's basedir, so
 * the stub writes every module's `target/jarpeek-classpath.txt` on the one
 * root invocation. A module absent from `cps` writes nothing (its
 * resolution failed). `exit` becomes the mvn exit code (0 default, 1 for a
 * partial reactor); dependency:sources resolves cleanly unless
 * `sourcesResult` says otherwise.
 */
function reactorCpExec(
  cps: { dir: string; content: string }[],
  { exit = 0, sourcesResult = {} as Pick<RunResult, "code" | "stderr"> } = {},
) {
  return stubExec(async (_cmd, args) => {
    if (args.includes("dependency:sources")) {
      return { stdout: "", stderr: sourcesResult.stderr ?? "", code: sourcesResult.code ?? 0 };
    }
    for (const { dir, content } of cps) {
      const file = join(dir, "target", "jarpeek-classpath.txt");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
    }
    return { stdout: "", stderr: exit === 0 ? "" : "[ERROR] reactor partially failed", code: exit };
  });
}

/**
 * exec stub for a single-module project: the one build-classpath invocation
 * writes `content` under its cwd's `target/`.
 */
function cpExec(content: string, sourcesResult: Pick<RunResult, "code" | "stderr"> = {}) {
  return stubExec(async (_cmd, args, opts) => {
    if (args.includes("dependency:sources")) {
      return { stdout: "", stderr: sourcesResult.stderr ?? "", code: sourcesResult.code ?? 0 };
    }
    const rel = args.find((a) => a.startsWith("-Dmdep.outputFile="))!.slice("-Dmdep.outputFile=".length);
    const file = join(opts.cwd ?? process.cwd(), ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    return { stdout: "", stderr: "", code: 0 };
  });
}

describe("resolveMaven: parsing the build-classpath output", () => {
  it("maps a unix cp.txt to external artifacts with sources siblings paired and non-m2 paths skipped", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, [
      "/home/dev/.m2/repository/org/springframework/spring-tx/6.1.4/spring-tx-6.1.4.jar",
    ]);
    const { exec, calls } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(resolution.reason).toBeUndefined();
    expect(resolution.artifacts).toHaveLength(2); // /opt/local/custom.jar skipped

    const lookup = indexBy(resolution.artifacts);
    const springTx = lookup(SPRING_TX);
    expect(springTx.kind).toBe("external");
    expect(springTx.configuration).toBe("compile+runtime+test");
    expect(springTx.binaryJar).toBe(
      join(m2, "org", "springframework", "spring-tx", "6.1.4", "spring-tx-6.1.4.jar"),
    );
    expect(springTx.sourcesJar).toBe(
      join(m2, "org", "springframework", "spring-tx", "6.1.4", "spring-tx-6.1.4-sources.jar"),
    );
    // exact shape: the legacy per-artifact metadata fields no longer exist
    expect(Object.keys(springTx).sort()).toEqual(["binaryJar", "configuration", "coordinates", "kind", "sourcesJar"]);

    const junit = lookup(JUNIT);
    expect(junit.kind).toBe("external");
    expect(junit.binaryJar).toBe(
      join(m2, "org", "junit", "jupiter", "junit-jupiter", "5.10.2", "junit-jupiter-5.10.2.jar"),
    );
    expect(junit.sourcesJar).toBeUndefined();

    // invocation shape: bare mvn (no wrapper in scratch, probe passed), ONE
    // reactor-wide run at the root — -fae so a failing module cannot discard
    // the rest, RELATIVE outputFile so each module writes under its own
    // target/ — then the sources run with the same command
    expect(calls).toHaveLength(2);
    const first = effectiveMvn(calls[0]);
    const second = effectiveMvn(calls[1]);
    expect(first.cmd).toBe("mvn");
    expect(first.args).toEqual([
      "-B",
      "-q",
      "-fae",
      "dependency:build-classpath",
      "-Dmdep.outputFile=target/jarpeek-classpath.txt",
    ]);
    expect(calls[0].opts.cwd).toBe(projectRoot);
    expect(calls[0].opts.timeoutMs).toBe(300_000);
    expect(second.cmd).toBe("mvn");
    expect(second.args).toEqual(["-B", "-q", "dependency:sources", "-DincludeScope=test"]);
    expect(calls[1].opts.cwd).toBe(projectRoot);
    expect(calls[1].opts.timeoutMs).toBe(300_000);
    // the per-module output file never outlives the resolution
    expect(existsSync(join(projectRoot, "target", "jarpeek-classpath.txt"))).toBe(false);
  });

  it("parses a windows cp.txt joined by ; with backslash m2 layout", async () => {
    const projectRoot = scratch();
    const { exec, calls } = cpExec(CP_WINDOWS);

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: PROBE_FOUND,
      m2Dir: "C:\\Users\\dev\\.m2\\repository",
    });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(1); // D:\opt\local\custom.jar skipped
    const b = indexBy(resolution.artifacts)("org.a:b:1.0");
    expect(b.kind).toBe("external");
    expect(b.configuration).toBe("compile+runtime+test");
    expect(b.binaryJar).toBe("C:\\Users\\dev\\.m2\\repository\\org\\a\\b\\1.0\\b-1.0.jar");
    expect(b.sourcesJar).toBeUndefined(); // no sibling in the fixture m2
    expect(b.provenance).toBeUndefined();
    const bare = effectiveMvn(calls[0]);
    expect(bare.args).toContain("-fae");
    expect(bare.args).not.toContain("--non-recursive");
    expect(bare.args[3]).toBe("dependency:build-classpath");
  });

  it("resolves a single windows entry with no ; separator (drive-letter pattern)", async () => {
    const projectRoot = scratch();
    const single = "C:\\Users\\dev\\.m2\\repository\\org\\a\\b\\1.0\\b-1.0.jar";
    const { exec } = cpExec(single);

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: PROBE_FOUND,
      m2Dir: "C:\\Users\\dev\\.m2\\repository",
    });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(1); // not split at "C:" into two duds
    const b = indexBy(resolution.artifacts)("org.a:b:1.0");
    expect(b.binaryJar).toBe(single);
    expect(b.provenance).toBeUndefined();
  });

  it("keeps unix splitting for a lone entry with no separator at all", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "m2");
    const lone = m2Jar(m2, "com", "example", "solo", "1.2", "solo-1.2.jar");
    const { exec } = cpExec(lone);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(1);
    expect(resolution.artifacts[0].coordinates).toBe("com.example:solo:1.2");
  });

  it("tolerates a failing dependency:sources run without failing resolution", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content, { code: 1, stderr: "sources download failed" });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe("resolveMaven: failure and degradation reasons", () => {
  it("reports mvn-failed:<stderr tail> on non-zero build-classpath exit, trimming long stderr", async () => {
    const projectRoot = scratch();
    const boom = await resolveMaven(projectRoot, {
      exec: stubExec(async (_cmd, args) =>
        args.includes("dependency:sources")
          ? { stdout: "", stderr: "", code: 0 }
          : { stdout: "", stderr: "boom", code: 1 },
      ).exec,
      mvnOnPath: PROBE_FOUND,
    });
    expect(boom.ok).toBe(false);
    expect(boom.reason).toBe("mvn-failed:boom");

    const longStderr = await resolveMaven(projectRoot, {
      exec: stubExec(async (_cmd, args) =>
        args.includes("dependency:sources")
          ? { stdout: "", stderr: "", code: 0 }
          : { stdout: "", stderr: "x".repeat(600) + "boom", code: 1 },
      ).exec,
      mvnOnPath: PROBE_FOUND,
    });
    expect(longStderr.reason).toBe(`mvn-failed:${"x".repeat(496)}boom`);
  });

  it("never yields an empty reason: non-zero exit with no stderr falls back to stdout, then a marker", async () => {
    const projectRoot = scratch();
    const quietStdout = await resolveMaven(projectRoot, {
      exec: stubExec(async (_cmd, args) =>
        args.includes("dependency:sources")
          ? { stdout: "", stderr: "", code: 0 }
          : { stdout: "[ERROR] build failed", stderr: "", code: 1 },
      ).exec,
      mvnOnPath: PROBE_FOUND,
    });
    expect(quietStdout.ok).toBe(false);
    expect(quietStdout.reason).toBe("mvn-failed:[ERROR] build failed");

    const fullyQuiet = await resolveMaven(projectRoot, {
      exec: stubExec(async (_cmd, args) =>
        args.includes("dependency:sources")
          ? { stdout: "", stderr: "", code: 0 }
          : { stdout: "", stderr: "", code: 1 },
      ).exec,
      mvnOnPath: PROBE_FOUND,
    });
    expect(fullyQuiet.reason).toBe("mvn-failed:exit 1 (no output)");
  });

  it("reports timeout when exec rejects with TimeoutError", async () => {
    const projectRoot = scratch();
    const { exec } = stubExec(() => Promise.reject(new TimeoutError("mvn", 180_000)));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "timeout" });
  });

  it("reports mvn-failed:<spawn error> when bare mvn fails to spawn despite a passing probe", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const cause = Object.assign(new Error("spawn mvn ENOENT"), { code: "ENOENT" });
    const { exec } = stubExec(() => Promise.reject(new SpawnError("mvn", cause)));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    // a spawn failure is an attempt failure, not absence — the probe decides absence
    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: 'mvn-failed:failed to spawn "mvn": spawn mvn ENOENT',
    });
  });

  it("reports no-mvn when the PATH probe finds no mvn, without spawning", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const { exec, calls } = cpExec("");

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: () => false });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-mvn" });
    expect(calls).toHaveLength(0); // probed, never spawned
  });

  it("reports no-classpath when the output file is empty or was never written", async () => {
    const projectRoot = scratch();
    const empty = await resolveMaven(projectRoot, {
      exec: cpExec("").exec,
      mvnOnPath: PROBE_FOUND,
    });
    expect(empty).toEqual({ ok: false, artifacts: [], reason: "no-classpath" });

    const neverWritten = await resolveMaven(projectRoot, {
      exec: stubExec(async () => ({ stdout: "", stderr: "", code: 0 })).exec,
      mvnOnPath: PROBE_FOUND,
    });
    expect(neverWritten).toEqual({ ok: false, artifacts: [], reason: "no-classpath" });
  });

  it("reports classpath-not-in-m2-layout when entries exist but none can anchor (derive quorum fails)", async () => {
    const projectRoot = scratch();
    // non-layout entries: no stem-shaped voter, so derivation has nothing to
    // vote on — a classpath outside any recognizable shape is a named failure,
    // not ok-with-zero-artifacts
    const relocated = ["/opt/libs/custom.jar", "/opt/other/thing.jar"].join(":");

    const resolution = await resolveMaven(projectRoot, {
      exec: cpExec(relocated).exec,
      mvnOnPath: PROBE_FOUND,
    });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: "mvn-failed:classpath-not-in-m2-layout",
    });
  });
});

describe("resolveMaven: wrapper selection", () => {
  it("uses <root>/mvnw on non-win32 platforms", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeFileSync(join(projectRoot, "mvnw"), "#!/bin/sh\n");
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    // probe pinned off: a system mvn would win the auto order before the wrapper
    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: () => false, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe(join(projectRoot, "mvnw"));
    expect(calls[0].args).not.toContain("--non-recursive");
    expect(calls[0].args[3]).toBe("dependency:build-classpath");
    expect(calls[0].opts.cwd).toBe(projectRoot);
  });

  it("spawns mvnw.cmd via cmd /c on win32, preferring it over mvnw", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    writeFileSync(join(projectRoot, "mvnw"), "#!/bin/sh\n");
    writeFileSync(join(projectRoot, "mvnw.cmd"), "@echo off\r\n");
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    // probe pinned off: a system mvn would win the auto order before the wrapper
    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: () => false, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args.slice(0, 2)).toEqual(["/c", join(projectRoot, "mvnw.cmd")]);
    expect(calls[0].args.slice(2)[3]).toBe("dependency:build-classpath");
  });

  it("falls back to bare mvn through cmd on win32 when no wrapper exists", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args).toEqual([
      "/c",
      "mvn",
      "-B",
      "-q",
      "-fae",
      "dependency:build-classpath",
      "-Dmdep.outputFile=target/jarpeek-classpath.txt",
    ]);
  });
});

describe("resolveMaven: build-tool strategy", () => {
  /** Executable root wrapper (unix shape). */
  function writeMvnw(projectRoot: string): void {
    const path = join(projectRoot, "mvnw");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
  }

  /** Write `content` as the classpath output for a build-classpath invocation. */
  async function writeCp(content: string, args: string[], opts: RunOptions): Promise<RunResult> {
    const rel = args.find((a) => a.startsWith("-Dmdep.outputFile="))!.slice("-Dmdep.outputFile=".length);
    const file = join(opts.cwd ?? process.cwd(), ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    return { stdout: "", stderr: "", code: 0 };
  }

  /**
   * exec stub where the SYSTEM command's build-classpath run fails with
   * `fail` and the wrapper's succeeds by writing `content` (identified via
   * `effectiveMvn`, so both unix and win32 shapes route correctly).
   */
  function systemFailsWrapperSucceeds(content: string, fail: Pick<RunResult, "code" | "stderr">) {
    return stubExec(async (cmd, args, opts) => {
      if (args.includes("dependency:sources")) return { stdout: "", stderr: "", code: 0 };
      if (effectiveMvn({ cmd, args, opts }).cmd === "mvn") {
        return { stdout: "", stderr: fail.stderr, code: fail.code };
      }
      return writeCp(content, args, opts);
    });
  }

  it("auto prefers the system mvn when the probe passes and a wrapper exists", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls.map((c) => effectiveMvn(c).cmd)).toEqual(["mvn", "mvn"]); // bp + sources, never the wrapper
  });

  it("auto uses the wrapper alone when the probe finds no system mvn", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: () => false, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls.every((c) => c.cmd === join(projectRoot, "mvnw"))).toBe(true);
  });

  it("auto retries with the wrapper after a failed system run; sources runs on the winner", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = systemFailsWrapperSucceeds(content, { code: 1, stderr: "boom" });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls.map((c) => effectiveMvn(c).cmd)).toEqual([
      "mvn",
      join(projectRoot, "mvnw"),
      join(projectRoot, "mvnw"),
    ]); // system bp fails → wrapper bp wins → sources on the wrapper
  });

  it("auto combines both attempts' details when every candidate fails", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    // both candidates fail with distinct tails: system stderr "boom", wrapper "wrapfail"
    const { exec } = stubExec(async (cmd, args) =>
      args.includes("dependency:sources")
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: cmd === "mvn" ? "boom" : "wrapfail", code: 1 },
    );

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: "mvn-failed:system: boom | wrapper: wrapfail",
    });
  });

  it("strategy system runs only the system mvn even with a wrapper present", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: PROBE_FOUND,
      m2Dir: m2,
      strategy: "system",
    });

    expect(resolution.ok).toBe(true);
    expect(calls.every((c) => effectiveMvn(c).cmd === "mvn")).toBe(true);
  });

  it("strategy system with a failing probe reports no-mvn without spawning", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const { exec, calls } = cpExec("");

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: () => false,
      strategy: "system",
    });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-mvn" });
    expect(calls).toHaveLength(0);
  });

  it("strategy wrapper runs only the wrapper even with a system mvn present", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: PROBE_FOUND,
      m2Dir: m2,
      strategy: "wrapper",
    });

    expect(resolution.ok).toBe(true);
    expect(calls.every((c) => c.cmd === join(projectRoot, "mvnw"))).toBe(true);
  });

  it("strategy wrapper with no wrapper file reports no-wrapper without spawning", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const { exec, calls } = cpExec("");

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: PROBE_FOUND,
      strategy: "wrapper",
    });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-wrapper" });
    expect(calls).toHaveLength(0);
  });

  it("auto advances past a system timeout to a working wrapper", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    let first = true;
    const { exec } = stubExec(async (cmd, args, opts) => {
      if (args.includes("dependency:sources")) return { stdout: "", stderr: "", code: 0 };
      if (first && effectiveMvn({ cmd, args, opts }).cmd === "mvn") {
        first = false;
        throw new TimeoutError("mvn", 300_000);
      }
      return writeCp(content, args, opts);
    });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
  });

  it("win32 auto: system first via cmd /c mvn, wrapper retry via cmd /c mvnw.cmd", async () => {
    const projectRoot = scratch();
    stubPlatform("win32");
    writeFileSync(join(projectRoot, "mvnw.cmd"), "@echo off\r\n");
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = systemFailsWrapperSucceeds(content, { code: 1, stderr: "boom" });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args.slice(0, 2)).toEqual(["/c", "mvn"]);
    expect(calls[1].cmd).toBe("cmd");
    expect(calls[1].args.slice(0, 2)).toEqual(["/c", join(projectRoot, "mvnw.cmd")]);
  });

  it("a failed system attempt's leftover classpath file never passes for the wrapper's output", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const { content, jars } = materialize(m2, CP_UNIX, []);
    // system: writes an unparseable (non-m2) cp file AND fails; wrapper: valid cp
    const { exec } = stubExec(async (cmd, args, opts) => {
      if (args.includes("dependency:sources")) return { stdout: "", stderr: "", code: 0 };
      if (effectiveMvn({ cmd, args, opts: opts ?? {} }).cmd === "mvn") {
        const file = join(projectRoot, "target", "jarpeek-classpath.txt");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "/opt/custom/repo/org/junk/j/1.0/j-1.0.jar", "utf8");
        return { stdout: "", stderr: "sysboom", code: 1 };
      }
      const rel = args.find((a) => a.startsWith("-Dmdep.outputFile="))!.slice("-Dmdep.outputFile=".length);
      const file = join(projectRoot, ...rel.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
      return { stdout: "", stderr: "", code: 0 };
    });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    const coordinates = resolution.artifacts.map((a) => a.coordinates);
    expect(coordinates).toContain(SPRING_TX); // the wrapper's fixture entries won
    expect(coordinates).not.toContain("org.junk:j:1.0"); // the system's junk did not
    expect(jars.length).toBeGreaterThan(0);
  });

  it("combined failure carries heterogeneous details: timeout | stderr tail", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const { exec } = stubExec(async (cmd, args) => {
      if (args.includes("dependency:sources")) return { stdout: "", stderr: "", code: 0 };
      if (cmd === "mvn") throw new TimeoutError("mvn", 300_000);
      return { stdout: "", stderr: "boom", code: 1 };
    });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: "mvn-failed:system: timeout | wrapper: boom",
    });
  });

  it("combined failure uses the exit marker when both attempts print nothing", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const { exec } = stubExec(async (cmd, args) =>
      args.includes("dependency:sources")
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 1 },
    );

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: "mvn-failed:system: exit 1 (no output) | wrapper: exit 1 (no output)",
    });
  });

  it("a partial system success is a win — the wrapper is never retried", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    writeMvnw(projectRoot);
    const m2 = join(projectRoot, "m2");
    const mod = join(projectRoot, "mod");
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(mod, "pom.xml"), "<project/>");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec, calls } = reactorCpExec([{ dir: projectRoot, content }], { exit: 1 }); // mod failed

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(resolution.partial).toContain("mod");
    expect(calls.every((c) => effectiveMvn(c).cmd === "mvn")).toBe(true);
  });
});

describe("resolveMaven: multi-module", () => {
  /** Scratch multi-module layout: root pom + mod/pom.xml, cleaned by afterEach. */
  function multiModule(): { projectRoot: string; mod: string } {
    const projectRoot = scratch();
    const mod = join(projectRoot, "mod");
    mkdirSync(mod);
    writeFileSync(join(projectRoot, "pom.xml"), "<project/>");
    writeFileSync(join(mod, "pom.xml"), "<project/>");
    return { projectRoot, mod };
  }

  it("runs ONE reactor-wide build-classpath and merges the per-module output files", async () => {
    const { projectRoot, mod } = multiModule();
    const m2 = join(projectRoot, "m2");
    const { content: rootCp } = materialize(m2, CP_UNIX, [
      "/home/dev/.m2/repository/org/springframework/spring-tx/6.1.4/spring-tx-6.1.4.jar",
    ]);
    const modCp = m2Jar(m2, "com", "example", "lib", "2.0", "lib-2.0.jar");
    const { exec, calls } = reactorCpExec([
      { dir: projectRoot, content: rootCp },
      { dir: mod, content: modCp },
    ]);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    const buildClasspathCalls = calls.filter((c) => c.args.includes("dependency:build-classpath"));
    expect(buildClasspathCalls).toHaveLength(1);
    expect(buildClasspathCalls[0].opts.cwd).toBe(projectRoot);
    expect(buildClasspathCalls[0].args).toContain("-fae");
    // root's 2 m2 entries + the module's 1, all distinct coordinates
    expect(resolution.artifacts).toHaveLength(3);
    const lookup = indexBy(resolution.artifacts);
    expect(lookup(SPRING_TX).sourcesJar).toBeDefined(); // sources sibling survived the merge
    expect(lookup(JUNIT)).toBeDefined();
    expect(lookup(LIB)).toBeDefined();

    // dependency:sources runs once at the root: the reactor covers all modules
    expect(calls.filter((c) => c.args.includes("dependency:sources"))).toHaveLength(1);
  });

  it("dedupes by coordinates when modules share a dependency", async () => {
    const { projectRoot, mod } = multiModule();
    const m2 = join(projectRoot, "m2");
    const { content: rootCp } = materialize(m2, CP_UNIX, []);
    const modCp = m2Jar(m2, "org", "junit", "jupiter", "junit-jupiter", "5.10.2", "junit-jupiter-5.10.2.jar");
    const { exec } = reactorCpExec([
      { dir: projectRoot, content: rootCp },
      { dir: mod, content: modCp },
    ]);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    // spring + junit once, not three entries
    expect(resolution.artifacts).toHaveLength(2);
    expect(resolution.artifacts.filter((a) => a.coordinates === JUNIT)).toHaveLength(1);
  });

  it("discovers nested modules (root/a/a1) recursively and captures them in the one run", async () => {
    const projectRoot = scratch();
    const a1 = join(projectRoot, "a", "a1");
    mkdirSync(a1, { recursive: true });
    writeFileSync(join(projectRoot, "pom.xml"), "<project/>");
    writeFileSync(join(a1, "pom.xml"), "<project/>");
    const m2 = join(projectRoot, "m2");
    const { content: rootCp } = materialize(m2, CP_UNIX, []);
    const nestedCp = m2Jar(m2, "com", "example", "nested", "3.0", "nested-3.0.jar");
    const { exec, calls } = reactorCpExec([
      { dir: projectRoot, content: rootCp },
      { dir: a1, content: nestedCp },
    ]);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    const buildClasspathCalls = calls.filter((c) => c.args.includes("dependency:build-classpath"));
    expect(buildClasspathCalls).toHaveLength(1);
    // the nested module's unique dependency is captured AND the root's survive
    expect(resolution.artifacts).toHaveLength(3);
    const lookup = indexBy(resolution.artifacts);
    expect(lookup(SPRING_TX)).toBeDefined();
    expect(lookup(JUNIT)).toBeDefined();
    expect(lookup("com.example:nested:3.0")).toBeDefined();
  });

  it("ignores a submodule whose build-classpath output is empty", async () => {
    const { projectRoot, mod } = multiModule();
    const m2 = join(projectRoot, "m2");
    const { content: rootCp } = materialize(m2, CP_UNIX, []);
    const { exec } = reactorCpExec([
      { dir: projectRoot, content: rootCp },
      { dir: mod, content: "" },
    ]);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(2);
  });

  it("degrades to partial when a module fails while the others resolved (exit 1)", async () => {
    const { projectRoot, mod } = multiModule();
    const m2 = join(projectRoot, "m2");
    const { content: rootCp } = materialize(m2, CP_UNIX, []);
    // -fae reactor: root resolved, mod never wrote its file, mvn exited 1
    const { exec } = reactorCpExec([{ dir: projectRoot, content: rootCp }], { exit: 1 });

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    // what resolved is trustworthy; the failed module is named, not fatal
    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts).toHaveLength(2); // root's spring-tx + junit
    expect(resolution.partial).toBe("modules failed to resolve: mod");
    expect(existsSync(join(mod, "target", "jarpeek-classpath.txt"))).toBe(false);
  });

  it("never ingests a stale output file left by a crashed previous run", async () => {
    const { projectRoot } = multiModule();
    const stale = join(projectRoot, "target", "jarpeek-classpath.txt");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "/opt/relocated/a/b/1.0/b-1.0.jar", "utf8");
    // mvn succeeds but writes nothing (the goal skipped the module)
    const { exec } = stubExec(async () => ({ stdout: "", stderr: "", code: 0 }));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-classpath" });
    expect(existsSync(stale)).toBe(false); // removed before the run, not parsed
  });

  it("maps a sibling's target/classes entry to a kind:module artifact on the module directory", async () => {
    const { projectRoot, mod } = multiModule();
    const m2 = join(projectRoot, "m2");
    const { content: rootCp } = materialize(m2, CP_UNIX, []);
    const jar = m2Jar(m2, "com", "example", "lib", "2.0", "lib-2.0.jar");
    // a reactor run resolving root's dependencies onto sibling mod's compiled
    // output plus one external jar
    const modClasses = join(mod, "target", "classes");
    const { exec } = reactorCpExec([
      // real mvn joins classpath entries with the platform delimiter (`;` on win32)
      { dir: projectRoot, content: `${modClasses}${delimiter}${jar}` },
      { dir: mod, content: "" },
    ]);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    const lookup = indexBy(resolution.artifacts);
    const module = lookup(moduleCoordinates(projectRoot, "mod"));
    expect(module.kind).toBe("module");
    expect(module.sourceDir).toBe(mod); // indexed in place, like a Gradle module
    expect(module.provenance).toBeUndefined();
    expect(module.warnings).toBeUndefined();
    expect(lookup(LIB)).toBeDefined(); // the m2 jar alongside it survives
  });
});

describe("mvnOnPathDefault", () => {
  const realPath = process.env.PATH;
  const realPathExt = process.env.PATHEXT;

  afterEach(() => {
    process.env.PATH = realPath;
    if (realPathExt !== undefined) process.env.PATHEXT = realPathExt;
    else delete process.env.PATHEXT;
    stubPlatform(realPlatform);
  });

  it("finds an executable mvn on a unix PATH and misses without one", () => {
    const projectRoot = scratch();
    const withMvn = join(projectRoot, "with-mvn");
    const withoutMvn = join(projectRoot, "without-mvn");
    mkdirSync(withMvn);
    mkdirSync(withoutMvn);
    writeFileSync(join(withMvn, "mvn"), "#!/bin/sh\n");
    chmodSync(join(withMvn, "mvn"), 0o755);
    stubPlatform("darwin");

    process.env.PATH = withMvn;
    expect(mvnOnPathDefault()).toBe(true);

    process.env.PATH = withoutMvn;
    expect(mvnOnPathDefault()).toBe(false);
  });

  it("matches mvn.cmd via PATHEXT on win32 and misses without one", () => {
    const projectRoot = scratch();
    const bin = join(projectRoot, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "mvn.cmd"), "@echo off\r\n");
    stubPlatform("win32");
    delete process.env.PATHEXT; // default extension list covers .cmd

    process.env.PATH = bin;
    expect(mvnOnPathDefault()).toBe(true);

    rmSync(join(bin, "mvn.cmd"));
    expect(mvnOnPathDefault()).toBe(false);
  });
});

describe("resolveMaven: relocated m2 roots (GH#12)", () => {
  it("honors JARPEEK_M2_DIR as the anchor", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "custom-m2");
    const { content } = materialize(m2, CP_UNIX, [
      "/home/dev/.m2/repository/org/springframework/spring-tx/6.1.4/spring-tx-6.1.4.jar",
    ]);
    const { exec } = cpExec(content);
    vi.stubEnv("JARPEEK_M2_DIR", m2);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(indexBy(resolution.artifacts)(SPRING_TX).binaryJar).toBe(
      join(m2, "org", "springframework", "spring-tx", "6.1.4", "spring-tx-6.1.4.jar"),
    );
    expect(resolution.warnings).toBeUndefined();
  });

  it("honors M2_REPO as the anchor", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "m2repo");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec } = cpExec(content);
    vi.stubEnv("M2_REPO", m2);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts.length).toBeGreaterThanOrEqual(2);
  });

  it("maps entries spanning several candidate roots (multi-anchor)", async () => {
    const projectRoot = scratch();
    const a = join(projectRoot, "root-a");
    const b = join(projectRoot, "root-b");
    const jarA = m2Jar(a, "com", "example", "alpha", "1.0", "alpha-1.0.jar");
    const jarB = m2Jar(b, "com", "example", "beta", "2.0", "beta-2.0.jar");
    const { exec } = cpExec([jarA, jarB].join(delimiter));
    vi.stubEnv("JARPEEK_M2_DIR", a);
    vi.stubEnv("M2_REPO", b);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(indexBy(resolution.artifacts)("com.example:alpha:1.0").binaryJar).toBe(jarA);
    expect(indexBy(resolution.artifacts)("com.example:beta:2.0").binaryJar).toBe(jarB);
  });

  it("threads an explicit roots.m2 list through the resolver", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "threaded-m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, {
      exec,
      mvnOnPath: PROBE_FOUND,
      roots: { m2: [m2] },
    });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts.some((a) => a.coordinates === SPRING_TX)).toBe(true);
  });

  it("derives the anchor from the classpath output when no candidate matches, and warns", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "unknown-m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const { exec } = cpExec(content);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(indexBy(resolution.artifacts)(SPRING_TX).binaryJar).toBe(
      join(m2, "org", "springframework", "spring-tx", "6.1.4", "spring-tx-6.1.4.jar"),
    );
    expect(resolution.warnings).toEqual([`maven: m2-anchor-derived:${m2}`]);
  });

  it("a single layout-shaped entry under an unknown root is not derived (quorum 2)", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "lonely-m2");
    const jar = m2Jar(m2, "com", "example", "lonely", "1.0", "lonely-1.0.jar");
    const { exec } = cpExec(jar);

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(false);
    expect(resolution.reason).toContain("classpath-not-in-m2-layout");
    expect(resolution.warnings).toBeUndefined();
  });

  it("an off-anchor system-scoped jar mixed into a resolved classpath stays skipped", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "m2");
    const { content } = materialize(m2, CP_UNIX, []);
    const stray = m2Jar(join(projectRoot, "vendor"), "com", "vendor", "stray", "9.9", "stray-9.9.jar");
    const { exec } = cpExec([content, stray].join(delimiter));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND, m2Dir: m2 });

    expect(resolution.ok).toBe(true);
    expect(resolution.artifacts.some((a) => a.coordinates === "com.vendor:stray:9.9")).toBe(false);
    expect(resolution.warnings).toBeUndefined();
  });
});

describe("resolveMaven: derivation robustness", () => {
  it("derives even when module target/classes entries also ride the classpath (anchor hits, not artifacts)", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "unknown-m2");
    const ext1 = m2Jar(m2, "org", "a", "alpha", "1.0", "alpha-1.0.jar");
    const ext2 = m2Jar(m2, "com", "b", "beta", "2.0", "beta-2.0.jar");
    const moduleClasses = join(projectRoot, "target", "classes");
    const { exec } = cpExec([moduleClasses, ext1, ext2].join(delimiter));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(indexBy(resolution.artifacts)("org.a:alpha:1.0").binaryJar).toBe(ext1);
    expect(indexBy(resolution.artifacts)("com.b:beta:2.0").binaryJar).toBe(ext2);
    expect(resolution.warnings).toEqual([`maven: m2-anchor-derived:${m2}`]);
  });

  it("a stray layout-shaped jar does not drag the anchor to a shared ancestor", async () => {
    const projectRoot = scratch();
    const home = join(projectRoot, "home");
    const repo = join(home, "repository");
    const inRepo = m2Jar(repo, "org", "a", "alpha", "1.0", "alpha-1.0.jar");
    const inRepo2 = m2Jar(repo, "com", "b", "beta", "2.0", "beta-2.0.jar");
    const stray = m2Jar(join(home, "vendor"), "com", "v", "stray", "9.9", "stray-9.9.jar");
    const { exec } = cpExec([inRepo, inRepo2, stray].join(delimiter));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(resolution.warnings).toEqual([`maven: m2-anchor-derived:${repo}`]);
    expect(resolution.artifacts.some((a) => a.coordinates === "com.v:stray:9.9")).toBe(false);
    expect(indexBy(resolution.artifacts)("org.a:alpha:1.0").binaryJar).toBe(inRepo);
  });

  it("a digit-suffixed root with a single shared top group still derives the true root", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "repo2");
    const spring = m2Jar(m2, "org", "springframework", "spring-tx", "6.1.4", "spring-tx-6.1.4.jar");
    const other = m2Jar(m2, "org", "springframework", "spring-core", "6.1.4", "spring-core-6.1.4.jar");
    const { exec } = cpExec([spring, other].join(delimiter));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution.ok).toBe(true);
    expect(resolution.warnings).toEqual([`maven: m2-anchor-derived:${m2}`]);
    expect(indexBy(resolution.artifacts)("org.springframework:spring-tx:6.1.4").binaryJar).toBe(spring);
    expect(indexBy(resolution.artifacts)("org.springframework:spring-core:6.1.4").binaryJar).toBe(other);
  });

  it("refuses derivation for an unrecognized root name — the loud failure contract holds", async () => {
    const projectRoot = scratch();
    const m2 = join(projectRoot, "plain");
    const a = m2Jar(m2, "org", "a", "alpha", "1.0", "alpha-1.0.jar");
    const b = m2Jar(m2, "com", "b", "beta", "2.0", "beta-2.0.jar");
    const { exec } = cpExec([a, b].join(delimiter));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({
      ok: false,
      artifacts: [],
      reason: "mvn-failed:classpath-not-in-m2-layout",
    });
  });
});
