/**
 * The help blocks: what a cold agent reads before its first call. These
 * tests pin the contract, not the prose — every block carries copy-pasteable
 * examples, every query command names its cheaper neighbor, and the top
 * level carries the frugal-path sentence plus the prime pointer. Enum
 * values are deliberately NOT asserted here: commander renders them from
 * the declared choices, so they cannot drift from validation.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  FIND_CLASS_HELP,
  INIT_HELP,
  MCP_HELP,
  OUTLINE_HELP,
  PRIME_HELP,
  READ_MEMBER_HELP,
  READ_RESOURCE_HELP,
  READ_SOURCE_HELP,
  RESOLVE_HELP,
  SEARCH_SYMBOLS_HELP,
  STATUS_HELP,
  TOP_LEVEL_HELP,
  WHERE_HELP,
} from "../../src/cli/help.js";

const execFileAsync = promisify(execFile);
const pkgRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", "src/cli/index.ts", ...args], {
      cwd: pkgRoot,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

describe("help constants", () => {
  it("the top level carries the frugal path, five examples, and the prime pointer", () => {
    expect(TOP_LEVEL_HELP).toContain(
      "the frugal path: find-class to locate the class, outline for its shape, read-member for exactly the member's code — read-source only when you need the whole file.",
    );
    expect(TOP_LEVEL_HELP).toContain("jarpeek find-class StringJoiner --limit 5");
    expect(TOP_LEVEL_HELP).toContain("jarpeek outline java.util.StringJoiner --kind method");
    expect(TOP_LEVEL_HELP).toContain(
      "jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'",
    );
    expect(TOP_LEVEL_HELP).toContain("jarpeek read-source com.example.lib.ApiClient --lines 40:80");
    expect(TOP_LEVEL_HELP).toContain(
      "jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method",
    );
    expect(TOP_LEVEL_HELP).toContain("full agent cheatsheet: jarpeek prime --full");
  });

  it("every query-command block has examples and a related: cross-link", () => {
    const blocks: Array<[string, string[]]> = [
      [FIND_CLASS_HELP, ["jarpeek find-class StringJoiner --limit 5"]],
      [
        OUTLINE_HELP,
        [
          "jarpeek outline java.util.StringJoiner --kind method",
          "jarpeek outline java.util.StringJoiner --minimal",
          "jarpeek outline com.example.lib.ApiClient --no-fields",
        ],
      ],
      [
        READ_MEMBER_HELP,
        [
          "jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'",
          "jarpeek read-member com.example.lib.ApiClient '#builder' '#build()'",
        ],
      ],
      [
        READ_SOURCE_HELP,
        [
          "jarpeek read-source com.example.lib.ApiClient --lines 40:80",
          "jarpeek read-source com.example.lib.ApiClient --full",
        ],
      ],
      [READ_RESOURCE_HELP, ["jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'"]],
      [
        SEARCH_SYMBOLS_HELP,
        ["jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method"],
      ],
      [RESOLVE_HELP, ["jarpeek resolve"]],
      [STATUS_HELP, ["jarpeek status"]],
      [WHERE_HELP, ["jarpeek where com.example:demo-lib:1.0.0"]],
    ];
    for (const [block, examples] of blocks) {
      expect(block).toContain("Examples:");
      for (const line of examples) {
        expect(block).toContain(line);
      }
      expect(block).toMatch(/^related:/m);
    }
  });

  it("the wiring-command blocks carry their examples", () => {
    expect(MCP_HELP).toContain("jarpeek mcp");
    expect(MCP_HELP).toContain("init");
    expect(PRIME_HELP).toContain("jarpeek prime --full");
    expect(PRIME_HELP).toContain("jarpeek prime --export");
    expect(INIT_HELP).toContain("jarpeek init --yes");
  });
});

describe("help output", () => {
  it("top-level --help ends with the frugal path and the prime pointer", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("the frugal path:");
    expect(stdout).toContain("full agent cheatsheet: jarpeek prime --full");
  });

  it("outline --help shows examples and the read-member cross-link", async () => {
    const { stdout, code } = await runCli(["outline", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("read-member");
  });

  it("read-source --help shows the related line naming outline", async () => {
    const { stdout, code } = await runCli(["read-source", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("related:");
    expect(stdout).toContain("outline");
  });
});
