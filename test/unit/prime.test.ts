/**
 * prime: the self-description command — unit tests over the pure selection
 * logic (content budgets, override precedence, hook-json envelope) plus a
 * subprocess smoke of the wired CLI flag surface.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLI_COMMANDS, MCP_TOOLS, defaultPrimeContent } from "../../src/prime/content.js";
import { prime } from "../../src/prime/command.js";

const execFileAsync = promisify(execFile);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG_ROOT, "node_modules", ".bin", "tsx");
const CLI = join(PKG_ROOT, "src", "cli", "index.ts");

const roots: string[] = [];

/** A tmp project root; with `primeMd`, a `.jarpeek/PRIME.md` override in it. */
function tmpProject(primeMd?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-prime-"));
  roots.push(dir);
  if (primeMd !== undefined) {
    mkdirSync(join(dir, ".jarpeek"));
    writeFileSync(join(dir, ".jarpeek", "PRIME.md"), primeMd);
  }
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Run the wired CLI inside `cwd` (the project root under test). */
async function runCli(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TSX, [CLI, ...args], { cwd });
  return stdout;
}

describe("defaultPrimeContent(mcp)", () => {
  it("fits the sub-60-word budget", () => {
    expect(wordCount(defaultPrimeContent("mcp"))).toBeLessThanOrEqual(60);
  });

  it("carries the rule", () => {
    expect(defaultPrimeContent("mcp")).toContain("find_class first");
  });

  it("lists all 9 tool names on one comma-separated line", () => {
    const line = defaultPrimeContent("mcp")
      .split("\n")
      .find((candidate) => MCP_TOOLS.every((tool) => candidate.includes(tool)));
    expect(line).toBeDefined();
    expect(line).toContain(",");
  });

  it("teaches lazy resolution, not indexing", () => {
    expect(defaultPrimeContent("mcp")).not.toMatch(/indexing/i);
    expect(defaultPrimeContent("mcp")).not.toMatch(/first index/i);
  });
});

describe("defaultPrimeContent(cli)", () => {
  const text = defaultPrimeContent("cli");

  it("is 600-1200 words and 3-9KB", () => {
    expect(wordCount(text)).toBeGreaterThanOrEqual(600);
    expect(wordCount(text)).toBeLessThanOrEqual(1200);
    expect(byteLength(text)).toBeGreaterThan(3 * 1024);
    expect(byteLength(text)).toBeLessThan(9 * 1024);
  });

  it("names all 9 commands", () => {
    for (const name of CLI_COMMANDS) expect(text, name).toContain(name);
  });

  it("documents --json, the provenance legend, and the export pointer", () => {
    expect(text).toContain("--json");
    expect(text).toContain("source");
    expect(text).toContain("decompiled");
    expect(text).toContain("signature");
    expect(text).toContain("full content: jarpeek prime --export");
  });

  it("teaches the lazy contracts", () => {
    // search-symbols is scoped: the artifact flag is part of the contract
    expect(text).toContain("search-symbols <query> --artifact <g:a:v>");
    // lazy resolution: first query (or stale manifest) resolves, never indexes
    expect(text).not.toMatch(/indexing/i);
    expect(text).not.toMatch(/first index/i);
    expect(text).toMatch(/auto-?resolve/);
    expect(text).toContain("never indexes");
    // misses are answers: suggestions / did-you-mean, exit 0
    expect(text).toContain("exit 0");
    expect(text).toContain("did you mean");
    // where's contract is the paths line
    expect(text).toContain("where <coordinates>");
  });

  it("documents the skeleton outline flags and the full-default read-source", () => {
    expect(text).toContain("--minimal");
    expect(text).toContain("--table");
    expect(text).toMatch(/whole file by default/);
    expect(text).not.toContain("outline by default");
    // the frugal entry points are named before the whole-file default
    expect(text).toMatch(/outline.*read-member/s);
  });

  it("bolds the rule", () => {
    expect(text).toMatch(
      /\*\*before grepping the repo for an external class[^]*find-class first\.?\*\*/i,
    );
  });
});

describe("name constants", () => {
  it("pin the 9 tool and command spellings", () => {
    expect([...MCP_TOOLS]).toEqual([
      "find_class",
      "outline",
      "read_member",
      "read_source",
      "read_resource",
      "search_symbols",
      "resolve",
      "status",
      "where",
    ]);
    expect([...CLI_COMMANDS]).toEqual([
      "find-class",
      "outline",
      "read-member",
      "read-source",
      "read-resource",
      "search-symbols",
      "resolve",
      "status",
      "where",
    ]);
  });
});

describe("prime() selection", () => {
  it("an override file wins for every mode", () => {
    const root = tmpProject("CUSTOM");
    expect(prime(root)).toEqual({ text: "CUSTOM", source: "override" });
    expect(prime(root, { mcp: true })).toEqual({ text: "CUSTOM", source: "override" });
    expect(prime(root, { full: true })).toEqual({ text: "CUSTOM", source: "override" });
  });

  it("exportContent bypasses the override and serves the default cli cheatsheet", () => {
    const root = tmpProject("CUSTOM");
    expect(prime(root, { exportContent: true })).toEqual({
      text: defaultPrimeContent("cli"),
      source: "default",
    });
  });

  it("flags force the mode when no override exists", () => {
    const root = tmpProject();
    expect(prime(root, { mcp: true }).text).toBe(defaultPrimeContent("mcp"));
    expect(prime(root, { full: true }).text).toBe(defaultPrimeContent("cli"));
  });

  it("auto-detects mcp via JARPEEK_PRIME_MODE, cli otherwise", () => {
    const root = tmpProject();
    try {
      vi.stubEnv("JARPEEK_PRIME_MODE", "mcp");
      expect(prime(root).text).toBe(defaultPrimeContent("mcp"));
      vi.stubEnv("JARPEEK_PRIME_MODE", undefined); // deletes the key
      expect(prime(root)).toEqual({ text: defaultPrimeContent("cli"), source: "default" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads primeMode from .jarpeek/config.json and outranks the env var", () => {
    const root = tmpProject();
    mkdirSync(join(root, ".jarpeek"), { recursive: true });
    writeFileSync(join(root, ".jarpeek", "config.json"), JSON.stringify({ primeMode: "mcp" }));
    try {
      vi.stubEnv("JARPEEK_PRIME_MODE", undefined); // config alone
      expect(prime(root).text).toBe(defaultPrimeContent("mcp"));
      vi.stubEnv("JARPEEK_PRIME_MODE", "mcp");
      expect(prime(root).text).toBe(defaultPrimeContent("mcp"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("flags outrank config.json; a corrupt config falls through to env", () => {
    const root = tmpProject();
    mkdirSync(join(root, ".jarpeek"), { recursive: true });
    writeFileSync(join(root, ".jarpeek", "config.json"), JSON.stringify({ primeMode: "mcp" }));
    expect(prime(root, { full: true }).text).toBe(defaultPrimeContent("cli"));

    const corrupt = tmpProject();
    mkdirSync(join(corrupt, ".jarpeek"), { recursive: true });
    writeFileSync(join(corrupt, ".jarpeek", "config.json"), "{not json");
    try {
      vi.stubEnv("JARPEEK_PRIME_MODE", "mcp");
      expect(prime(corrupt).text).toBe(defaultPrimeContent("mcp"));
      vi.stubEnv("JARPEEK_PRIME_MODE", undefined);
      expect(prime(corrupt).text).toBe(defaultPrimeContent("cli"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("hook-json envelope", () => {
  it("wraps the selected text as a SessionStart additionalContext", () => {
    const result = prime(tmpProject(), { full: true, hookJson: true });
    const parsed = JSON.parse(result.text) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(defaultPrimeContent("cli"));
    expect(result.source).toBe("default");
  });

  it("wraps override text verbatim inside the envelope", () => {
    const result = prime(tmpProject("CUSTOM"), { hookJson: true });
    const parsed = JSON.parse(result.text) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toBe("CUSTOM");
    expect(result.source).toBe("override");
  });
});

describe("CLI wiring", () => {
  it("prime in a tmp project exits 0 with the cli cheatsheet on stdout", async () => {
    const stdout = await runCli(tmpProject(), ["prime"]);
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain("find-class");
  });

  it("--mcp prints the short card", async () => {
    const stdout = await runCli(tmpProject(), ["prime", "--mcp"]);
    expect(stdout).toContain("find_class first");
  });

  it("--hook-json prints one parseable SessionStart envelope", async () => {
    const stdout = await runCli(tmpProject(), ["prime", "--hook-json"]);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("find-class");
  });
});
