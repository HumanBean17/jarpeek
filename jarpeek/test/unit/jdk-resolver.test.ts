import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveJdk } from "../../src/resolver/jdk.js";

const originalJavaHome = process.env.JAVA_HOME;

afterEach(() => {
  if (originalJavaHome === undefined) {
    delete process.env.JAVA_HOME;
  } else {
    process.env.JAVA_HOME = originalJavaHome;
  }
});

describe("resolveJdk (real JAVA_HOME)", () => {
  const home = process.env.JAVA_HOME;
  const srcZip = home === undefined ? undefined : join(home, "lib", "src.zip");
  const hasRealJdk = Boolean(home && srcZip && existsSync(srcZip));

  it.skipIf(!hasRealJdk)("resolves the real JDK's src.zip as a source artifact", async () => {
    const { artifact, warnings } = await resolveJdk();

    const release = readFileSync(join(home!, "release"), "utf8");
    const match = /^JAVA_VERSION="([^"]+)"/m.exec(release);
    expect(match).not.toBeNull();

    expect(artifact?.coordinates).toBe(`jdk:${match![1]}`);
    expect(artifact?.kind).toBe("jdk");
    expect(artifact?.configuration).toBe("jdk");
    expect(artifact?.noDecompile).toBe(true);
    expect(artifact?.provenance).toBe("source");
    expect(artifact?.sourcesJar).toBe(srcZip);
    expect(existsSync(artifact!.sourcesJar!)).toBe(true);
    expect(artifact?.warnings).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("resolveJdk", () => {
  let root: string | undefined;

  /** Fresh scratch: a javaHome with an empty `lib/`, and a cache dir. */
  function scratch(): { javaHome: string; cacheDir: string } {
    root = mkdtempSync(join(tmpdir(), "jarpeek-jdk-"));
    const javaHome = join(root, "jdk");
    mkdirSync(join(javaHome, "lib"), { recursive: true });
    return { javaHome, cacheDir: join(root, "cache") };
  }

  function writeRelease(javaHome: string, version: string): void {
    writeFileSync(join(javaHome, "release"), `JAVA_VERSION="${version}"\nJAVA_VERSION_DATE="2026-01-20"\n`);
  }

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("extracts via jimage when src.zip is absent, then skips extraction on the second call", async () => {
    const { javaHome, cacheDir } = scratch();
    writeRelease(javaHome, "17.0.9");

    const extractDir = join(cacheDir, "v1", "jdk-modules", "17.0.9");
    const seenArgs: string[][] = [];
    const runJimage = async (args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> => {
      seenArgs.push(args);
      mkdirSync(extractDir, { recursive: true }); // stand in for the real extraction
      return { stdout: "", stderr: "", code: 0 };
    };

    const first = await resolveJdk({ javaHome, cacheDir, runJimage });
    expect(seenArgs).toEqual([["extract", "--dir", extractDir, join(javaHome, "lib", "modules")]]);
    expect(first.artifact?.coordinates).toBe("jdk:17.0.9");
    expect(first.artifact?.kind).toBe("jdk");
    expect(first.artifact?.noDecompile).toBe(true);
    expect(first.artifact?.sourcesJar).toBeUndefined();
    expect(first.artifact?.classesDir).toBe(extractDir);
    expect(first.artifact?.provenance).toBe("signature");
    expect(first.artifact?.warnings).toEqual([
      "src.zip missing; using jimage-extracted class files (signatures only)",
    ]);
    expect(first.warnings).toEqual([
      "src.zip missing; using jimage-extracted class files (signatures only)",
    ]);

    // dir already on disk → no second jimage run
    const second = await resolveJdk({ javaHome, cacheDir, runJimage });
    expect(seenArgs).toHaveLength(1);
    expect(second.artifact?.classesDir).toBe(extractDir);
    expect(second.artifact?.provenance).toBe("signature");
  });

  it("returns null with a warning when jimage fails", async () => {
    const { javaHome, cacheDir } = scratch();
    writeRelease(javaHome, "21.0.1");
    const runJimage = async () => ({ stdout: "", stderr: "boom", code: 1 });

    const { artifact, warnings } = await resolveJdk({ javaHome, cacheDir, runJimage });
    expect(artifact).toBeNull();
    expect(warnings).toEqual(["jimage extract failed"]);
  });

  it("returns null with a warning when javaHome is empty or unset", async () => {
    const explicit = await resolveJdk({ javaHome: "" });
    expect(explicit.artifact).toBeNull();
    expect(explicit.warnings).toEqual(["no JAVA_HOME; JDK sources unavailable"]);

    delete process.env.JAVA_HOME;
    const byEnv = await resolveJdk();
    expect(byEnv.artifact).toBeNull();
    expect(byEnv.warnings).toEqual(["no JAVA_HOME; JDK sources unavailable"]);
  });

  it("falls back to the javaHome basename with jdk-version-unknown when release is missing", async () => {
    delete process.env.JAVA_HOME; // pin the fallback to the javaHome we passed
    const { javaHome, cacheDir } = scratch();
    writeFileSync(join(javaHome, "lib", "src.zip"), "PK"); // no release file

    const { artifact, warnings } = await resolveJdk({ javaHome, cacheDir });
    expect(artifact?.coordinates).toBe(`jdk:${basename(javaHome)}`);
    expect(artifact?.sourcesJar).toBe(join(javaHome, "lib", "src.zip"));
    expect(artifact?.provenance).toBe("source");
    expect(warnings).toEqual(["jdk-version-unknown"]);
  });
});
