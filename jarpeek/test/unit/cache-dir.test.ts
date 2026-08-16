import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCacheDir, resolveCacheDir } from "../../src/util/cache-dir.js";

const ENV_KEY = "JARPEEK_CACHE_DIR";
const originalEnv = process.env[ENV_KEY];
const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;

function tmpPath(): string {
  return mkdtempSync(join(tmpdir(), "jarpeek-cache-"));
}

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnv;
  }
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData;
  }
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("resolveCacheDir", () => {
  it("returns JARPEEK_CACHE_DIR verbatim when set", () => {
    const dir = tmpPath();
    try {
      process.env[ENV_KEY] = dir;
      expect(resolveCacheDir()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("darwin resolves to ~/Library/Caches/jarpeek", () => {
    delete process.env[ENV_KEY];
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(resolveCacheDir()).toBe(join(homedir(), "Library", "Caches", "jarpeek"));
  });

  it("linux resolves to ~/.cache/jarpeek", () => {
    delete process.env[ENV_KEY];
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveCacheDir()).toBe(join(homedir(), ".cache", "jarpeek"));
  });

  it("win32 resolves to %LOCALAPPDATA%/jarpeek", () => {
    delete process.env[ENV_KEY];
    delete process.env.LOCALAPPDATA;
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveCacheDir()).toBe(join(homedir(), "AppData", "Local", "jarpeek"));
  });
});

describe("ensureCacheDir", () => {
  it("creates the resolved directory recursively", () => {
    const base = tmpPath();
    const nested = join(base, "a", "b", "jarpeek");
    try {
      process.env[ENV_KEY] = nested;
      const created = ensureCacheDir();
      expect(created).toBe(nested);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
