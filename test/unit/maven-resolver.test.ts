import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * `-sources.jar` sibling for entries listed in `sources`. The fixture
 * separators survive untouched, so the resolver sees the original
 * `:`/`;`/backslash shapes with only the m2 base swapped.
 */
function materialize(m2: string, cp: string, sources: string[]): { content: string; jars: string[] } {
  const jars: string[] = [];
  const sourcesRel = new Set(sources.map(relFromFixture));
  let content = cp;
  for (const raw of cp.split(/\r?\n/).flatMap((line) => line.split(/[;:](?=[A-Za-z]:|\/)/))) {
    if (!raw.endsWith(".jar") || !raw.includes("repository")) continue;
    const rel = relFromFixture(raw);
    const jar = join(m2, ...rel.split(/[\\/]/));
    mkdirSync(dirname(jar), { recursive: true });
    writeFileSync(jar, "jar");
    jars.push(jar);
    if (sourcesRel.has(rel)) writeFileSync(`${jar.slice(0, -".jar".length)}-sources.jar`, "sources");
    content = content.split(raw).join(jar);
  }
  return { content, jars };
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
    expect(calls[0].cmd).toBe("mvn");
    expect(calls[0].args).toEqual([
      "-B",
      "-q",
      "-fae",
      "dependency:build-classpath",
      "-Dmdep.outputFile=target/jarpeek-classpath.txt",
    ]);
    expect(calls[0].opts.cwd).toBe(projectRoot);
    expect(calls[0].opts.timeoutMs).toBe(300_000);
    expect(calls[1].cmd).toBe("mvn");
    expect(calls[1].args).toEqual(["-B", "-q", "dependency:sources", "-DincludeScope=test"]);
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
    expect(calls[0].args).toContain("-fae");
    expect(calls[0].args).not.toContain("--non-recursive");
    expect(calls[0].args[3]).toBe("dependency:build-classpath");
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

  it("reports no-mvn when bare mvn fails to spawn despite a passing probe", async () => {
    const projectRoot = scratch();
    stubPlatform("darwin");
    const cause = Object.assign(new Error("spawn mvn ENOENT"), { code: "ENOENT" });
    const { exec } = stubExec(() => Promise.reject(new SpawnError("mvn", cause)));

    const resolution = await resolveMaven(projectRoot, { exec, mvnOnPath: PROBE_FOUND });

    expect(resolution).toEqual({ ok: false, artifacts: [], reason: "no-mvn" });
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

  it("reports classpath-not-in-m2-layout when entries exist but none match the m2 anchor", async () => {
    const projectRoot = scratch();
    const relocated = [
      "/opt/custom/repo/org/a/b/1.0/b-1.0.jar",
      "/opt/custom/repo/com/example/lib/2.0/lib-2.0.jar",
    ].join(":");

    const resolution = await resolveMaven(projectRoot, {
      exec: cpExec(relocated).exec,
      mvnOnPath: PROBE_FOUND,
    });

    // a relocated localRepository is a named failure, not ok-with-zero-artifacts
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

    const resolution = await resolveMaven(projectRoot, { exec, m2Dir: m2 });

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

    const resolution = await resolveMaven(projectRoot, { exec, m2Dir: m2 });

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
      { dir: projectRoot, content: `${modClasses}:${jar}` },
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
