/**
 * Build-tool strategy convergence: flag > env > config.json > auto, with
 * invalid values at any layer falling through to the next. Mirrors the
 * primeMode tests' shape — the same three-surface knob pattern with a
 * deliberate precedence difference (env beats config here).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveBuildToolStrategy } from "../../src/resolver/strategy.js";

let root: string | undefined;

/** Fresh scratch project root (cleaned in afterEach). */
function scratch(): string {
  root = mkdtempSync(join(tmpdir(), "jarpeek-strategy-"));
  return root;
}

/** Write `.jarpeek/config.json` with the given raw file content. */
function writeConfig(projectRoot: string, content: string): void {
  mkdirSync(join(projectRoot, ".jarpeek"), { recursive: true });
  writeFileSync(join(projectRoot, ".jarpeek", "config.json"), content);
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.unstubAllEnvs();
});

describe("effectiveBuildToolStrategy", () => {
  it("defaults to auto with nothing set", () => {
    expect(effectiveBuildToolStrategy(scratch())).toBe("auto");
  });

  it("the flag beats env and config", () => {
    const r = scratch();
    writeConfig(r, JSON.stringify({ buildTool: "system" }));
    vi.stubEnv("JARPEEK_BUILD_TOOL", "system");
    expect(effectiveBuildToolStrategy(r, "wrapper")).toBe("wrapper");
  });

  it("env beats config", () => {
    const r = scratch();
    writeConfig(r, JSON.stringify({ buildTool: "wrapper" }));
    vi.stubEnv("JARPEEK_BUILD_TOOL", "system");
    expect(effectiveBuildToolStrategy(r)).toBe("system");
  });

  it("config decides when flag and env are unset", () => {
    const r = scratch();
    writeConfig(r, JSON.stringify({ buildTool: "wrapper" }));
    expect(effectiveBuildToolStrategy(r)).toBe("wrapper");
  });

  it("a config without the field falls through to auto", () => {
    const r = scratch();
    writeConfig(r, JSON.stringify({ primeMode: "cli" }));
    expect(effectiveBuildToolStrategy(r)).toBe("auto");
  });

  it("a corrupt config falls through to auto", () => {
    const r = scratch();
    writeConfig(r, "{not json");
    expect(effectiveBuildToolStrategy(r)).toBe("auto");
  });

  it("invalid env and config values fall through to auto", () => {
    const r = scratch();
    writeConfig(r, JSON.stringify({ buildTool: "nonsense" }));
    vi.stubEnv("JARPEEK_BUILD_TOOL", "garbage");
    expect(effectiveBuildToolStrategy(r)).toBe("auto");
  });

  it("an invalid flag value falls through to env", () => {
    const r = scratch();
    vi.stubEnv("JARPEEK_BUILD_TOOL", "system");
    expect(effectiveBuildToolStrategy(r, "garbage")).toBe("system");
  });
});
