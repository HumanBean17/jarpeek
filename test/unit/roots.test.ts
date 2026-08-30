/**
 * Cache-root convergence: the ordered candidate chain every resolver
 * anchors against — override > env > project config > global config >
 * settings.xml > default. Mirrors strategy.test.ts's shape (scratch
 * project, config writer, stubbed env); the settings.xml location is a
 * seam so no test reads the real home.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveGradleCacheRoot, effectiveM2Roots } from "../../src/resolver/roots.js";

let root: string | undefined;
let home: string | undefined;

/** Fresh scratch project root (cleaned in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-roots-"));
  return root;
}

/** Fresh scratch home for the global config. */
function scratchHome(): string {
  home = mkdtempSync(join(tmpdir(), "jarpeek-roots-home-"));
  return home;
}

/** Write `.jarpeek/config.json` with the given raw file content. */
function writeConfig(projectRoot: string, content: string): void {
  mkdirSync(join(projectRoot, ".jarpeek"), { recursive: true });
  writeFileSync(join(projectRoot, ".jarpeek", "config.json"), content);
}

/** Write the global config under a scratch home and point JARPEEK_HOME at it. */
function writeGlobal(content: string): string {
  const h = scratchHome();
  mkdirSync(join(h, ".config", "jarpeek"), { recursive: true });
  writeFileSync(join(h, ".config", "jarpeek", "config.json"), content);
  vi.stubEnv("JARPEEK_HOME", h);
  return h;
}

/** Write a settings.xml with the given localRepository raw value. */
function writeSettings(value: string): string {
  const h = scratchHome();
  mkdirSync(join(h, ".m2"), { recursive: true });
  writeFileSync(join(h, ".m2", "settings.xml"), `<settings><localRepository>${value}</localRepository></settings>`);
  return join(h, ".m2", "settings.xml");
}

/** Unset every env var the convergence reads, for hermetic default cases. */
function clearEnv(): void {
  for (const name of [
    "JARPEEK_M2_DIR",
    "M2_REPO",
    "JARPEEK_GRADLE_CACHE_DIR",
    "GRADLE_USER_HOME",
    "JARPEEK_HOME",
  ]) {
    vi.stubEnv(name, undefined);
  }
}

afterEach(() => {
  for (const dir of [root, home]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  root = undefined;
  home = undefined;
  vi.unstubAllEnvs();
});

describe("effectiveM2Roots", () => {
  it("defaults to ~/.m2/repository with nothing set", () => {
    clearEnv();
    expect(effectiveM2Roots(scratch())).toEqual([
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
  });

  it("the override beats every layer", () => {
    clearEnv();
    const r = scratch();
    writeConfig(r, JSON.stringify({ m2Dir: "/from/config" }));
    vi.stubEnv("JARPEEK_M2_DIR", "/from/env");
    expect(effectiveM2Roots(r, { m2Dir: "/from/override" })).toEqual([
      { path: "/from/override", source: "override" },
    ]);
  });

  it("JARPEEK_M2_DIR beats M2_REPO and both are listed", () => {
    clearEnv();
    vi.stubEnv("JARPEEK_M2_DIR", "/custom/m2");
    vi.stubEnv("M2_REPO", "/other/m2");
    expect(effectiveM2Roots(scratch()).map((c) => c.source)).toEqual(["env", "env", "default"]);
    const [first, second] = effectiveM2Roots(scratch());
    expect(first.path).toBe("/custom/m2");
    expect(second.path).toBe("/other/m2");
  });

  it("env beats project config, which beats global config, which beats settings.xml", () => {
    clearEnv();
    const r = scratch();
    writeConfig(r, JSON.stringify({ m2Dir: "/project/m2" }));
    writeGlobal(JSON.stringify({ m2Dir: "/global/m2" }));
    const settings = writeSettings("/settings/m2");
    expect(effectiveM2Roots(r, { settingsPath: settings })).toEqual([
      { path: "/project/m2", source: "config" },
      { path: "/global/m2", source: "config" },
      { path: "/settings/m2", source: "settings" },
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
    vi.stubEnv("JARPEEK_M2_DIR", "/env/m2");
    expect(effectiveM2Roots(r, { settingsPath: settings })[0]).toEqual({ path: "/env/m2", source: "env" });
  });

  it("settings.xml localRepository is honored, with ${user.home} interpolated", () => {
    clearEnv();
    const settings = writeSettings("${user.home}/relocated/m2");
    expect(effectiveM2Roots(scratch(), { settingsPath: settings })).toEqual([
      { path: join(homedir(), "relocated", "m2"), source: "settings" },
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
  });

  it("a relative localRepository is dropped and a missing settings.xml falls to default", () => {
    clearEnv();
    const relative = writeSettings("relative/repo");
    expect(effectiveM2Roots(scratch(), { settingsPath: relative })).toEqual([
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
    expect(effectiveM2Roots(scratch(), { settingsPath: join(scratchHome(), ".m2", "settings.xml") })).toEqual([
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
  });

  it("invalid config values fall through silently", () => {
    clearEnv();
    const r = scratch();
    writeConfig(r, JSON.stringify({ m2Dir: "relative/m2" }));
    writeGlobal("{not json");
    expect(effectiveM2Roots(r)).toEqual([
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
  });

  it("an undefined projectRoot skips the config layers", () => {
    clearEnv();
    vi.stubEnv("JARPEEK_M2_DIR", "/env/m2");
    const r = scratch();
    writeConfig(r, JSON.stringify({ m2Dir: "/project/m2" }));
    expect(effectiveM2Roots(undefined)).toEqual([
      { path: "/env/m2", source: "env" },
      { path: join(homedir(), ".m2", "repository"), source: "default" },
    ]);
  });

  it("a later layer naming the default path adds nothing (dedup)", () => {
    clearEnv();
    vi.stubEnv("JARPEEK_M2_DIR", join(homedir(), ".m2", "repository"));
    expect(effectiveM2Roots(scratch())).toEqual([
      { path: join(homedir(), ".m2", "repository"), source: "env" },
    ]);
  });
});

describe("effectiveGradleCacheRoot", () => {
  it("defaults to ~/.gradle/caches/modules-2/files-2.1 with nothing set", () => {
    clearEnv();
    expect(effectiveGradleCacheRoot(scratch())).toEqual({
      path: join(homedir(), ".gradle", "caches", "modules-2", "files-2.1"),
      source: "default",
    });
  });

  it("JARPEEK_GRADLE_CACHE_DIR beats GRADLE_USER_HOME, which beats config", () => {
    clearEnv();
    const r = scratch();
    writeConfig(r, JSON.stringify({ gradleCacheDir: "/project/gradle" }));
    vi.stubEnv("GRADLE_USER_HOME", "/g");
    expect(effectiveGradleCacheRoot(r)).toEqual({
      path: "/g/caches/modules-2/files-2.1",
      source: "env",
    });
    vi.stubEnv("JARPEEK_GRADLE_CACHE_DIR", "/explicit/gradle");
    expect(effectiveGradleCacheRoot(r)).toEqual({ path: "/explicit/gradle", source: "env" });
  });

  it("project config beats global config; a relative value falls through", () => {
    clearEnv();
    const r = scratch();
    writeConfig(r, JSON.stringify({ gradleCacheDir: "/project/gradle" }));
    writeGlobal(JSON.stringify({ gradleCacheDir: "/global/gradle" }));
    expect(effectiveGradleCacheRoot(r)).toEqual({ path: "/project/gradle", source: "config" });
    const r2 = scratch();
    writeConfig(r2, JSON.stringify({ gradleCacheDir: "relative/gradle" }));
    expect(effectiveGradleCacheRoot(r2)).toEqual({ path: "/global/gradle", source: "config" });
  });

  it("the override beats everything", () => {
    clearEnv();
    vi.stubEnv("JARPEEK_GRADLE_CACHE_DIR", "/explicit/gradle");
    expect(effectiveGradleCacheRoot(scratch(), { gradleDir: "/override/gradle" })).toEqual({
      path: "/override/gradle",
      source: "override",
    });
  });
});
