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
    expect(artifact?.sourcesJar).toBe(srcZip);
    expect(existsSync(artifact!.sourcesJar!)).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("resolveJdk", () => {
  let root: string | undefined;

  /** Fresh scratch: a javaHome with an empty `lib/`. */
  function scratch(): string {
    root = mkdtempSync(join(tmpdir(), "jarpeek-jdk-"));
    const javaHome = join(root, "jdk");
    mkdirSync(join(javaHome, "lib"), { recursive: true });
    return javaHome;
  }

  function writeRelease(javaHome: string, version: string): void {
    writeFileSync(join(javaHome, "release"), `JAVA_VERSION="${version}"\nJAVA_VERSION_DATE="2026-01-20"\n`);
  }

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("resolves lib/src.zip as a slim sourcesJar artifact with no classesDir", async () => {
    delete process.env.JAVA_HOME; // pin resolution to the javaHome we pass
    const javaHome = scratch();
    writeRelease(javaHome, "21.0.0");
    writeFileSync(join(javaHome, "lib", "src.zip"), ""); // existence is all that is checked

    const { artifact, warnings } = await resolveJdk({ javaHome });

    // exact shape: the jimage-era provenance/warnings/classesDir are gone
    expect(artifact).toEqual({
      coordinates: "jdk:21.0.0",
      kind: "jdk",
      configuration: "jdk",
      noDecompile: true,
      sourcesJar: join(javaHome, "lib", "src.zip"),
    });
    expect(warnings).toEqual([]);
  });

  it("returns null with a warning when src.zip is missing", async () => {
    delete process.env.JAVA_HOME;
    const javaHome = scratch();
    writeRelease(javaHome, "21.0.1"); // well-formed release, no lib/src.zip

    const { artifact, warnings } = await resolveJdk({ javaHome });

    expect(artifact).toBeNull();
    expect(warnings).toEqual(["src.zip missing; JDK classes unavailable"]);
  });

  it("returns null with a warning when javaHome is unset or empty", async () => {
    delete process.env.JAVA_HOME;
    const byEnv = await resolveJdk();
    expect(byEnv.artifact).toBeNull();
    expect(byEnv.warnings).toEqual(["no JAVA_HOME; JDK sources unavailable"]);

    const explicit = await resolveJdk({ javaHome: "" });
    expect(explicit.artifact).toBeNull();
    expect(explicit.warnings).toEqual(["no JAVA_HOME; JDK sources unavailable"]);
  });

  it("falls back to the javaHome basename when release is missing", async () => {
    delete process.env.JAVA_HOME;
    const javaHome = scratch();
    writeFileSync(join(javaHome, "lib", "src.zip"), ""); // no release file

    const { artifact, warnings } = await resolveJdk({ javaHome });

    expect(artifact?.coordinates).toBe(`jdk:${basename(javaHome)}`);
    expect(artifact?.sourcesJar).toBe(join(javaHome, "lib", "src.zip"));
    expect(warnings).toEqual([]);
  });
});
