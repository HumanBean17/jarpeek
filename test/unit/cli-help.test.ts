/**
 * The help blocks: what a cold agent reads before its first call. These
 * tests pin the contract, not the prose — every block carries copy-pasteable
 * examples, every query command names its cheaper neighbor, and the top
 * level carries the frugal-path sentence plus the prime pointer. Enum
 * values are deliberately NOT asserted here: commander renders them from
 * the declared choices, so they cannot drift from validation. The blocks
 * are functions of the message catalog: `en` is pinned byte-for-byte (the
 * default-output regression oracle), `ru` is pinned on labels, examples,
 * and the surfaces `--lang ru` actually switches.
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { catalog } from "../../src/cli/i18n/index.js";
import {
  findClassHelp,
  initHelp,
  mcpHelp,
  outlineHelp,
  primeHelp,
  readMemberHelp,
  readResourceHelp,
  readSourceHelp,
  resolveHelp,
  searchSymbolsHelp,
  statusHelp,
  topLevelHelp,
  whereHelp,
} from "../../src/cli/help.js";

const execFileAsync = promisify(execFile);
const pkgRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const en = catalog("en");
const ru = catalog("ru");

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A tmp project root whose `.jarpeek/config.json` pins `language`. */
function configDir(language: string): string {
  const root = mkdtempSync(join(tmpdir(), "jarpeek-help-"));
  dirs.push(root);
  mkdirSync(join(root, ".jarpeek"), { recursive: true });
  writeFileSync(join(root, ".jarpeek", "config.json"), JSON.stringify({ language }));
  return root;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    // node by absolute path: a bare `npx` is a .cmd shim on win32, unspawnable
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/cli/index.ts", ...args],
      { cwd: pkgRoot },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

describe("help constants (en)", () => {
  it("the top level carries the frugal path, five examples, and the prime pointer", () => {
    const block = topLevelHelp(en);
    expect(block).toContain(
      "the frugal path: find-class to locate the class, outline for its shape, read-member for exactly the member's code — read-source only when you need the whole file.",
    );
    expect(block).toContain("jarpeek find-class StringJoiner --limit 5");
    expect(block).toContain("jarpeek outline java.util.StringJoiner --kind method");
    expect(block).toContain(
      "jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'",
    );
    expect(block).toContain("jarpeek read-source com.example.lib.ApiClient --lines 40:80");
    expect(block).toContain(
      "jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method",
    );
    expect(block).toContain("full agent cheatsheet: jarpeek prime --full");
  });

  it("every query-command block has examples and a related: cross-link", () => {
    const blocks: Array<[string, string[]]> = [
      [findClassHelp(en), ["jarpeek find-class StringJoiner --limit 5"]],
      [
        outlineHelp(en),
        [
          "jarpeek outline java.util.StringJoiner --kind method",
          "jarpeek outline java.util.StringJoiner --minimal",
          "jarpeek outline com.example.lib.ApiClient --no-fields",
        ],
      ],
      [
        readMemberHelp(en),
        [
          "jarpeek read-member com.example.lib.ApiClient '#execute(Request,int)'",
          "jarpeek read-member com.example.lib.ApiClient '#builder' '#build()'",
        ],
      ],
      [
        readSourceHelp(en),
        [
          "jarpeek read-source com.example.lib.ApiClient --lines 40:80",
          "jarpeek read-source com.example.lib.ApiClient --full",
        ],
      ],
      [readResourceHelp(en), ["jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'"]],
      [
        searchSymbolsHelp(en),
        ["jarpeek search-symbols builder --artifact com.example:demo-lib:1.0.0 --kind method"],
      ],
      [resolveHelp(en), ["jarpeek resolve"]],
      [statusHelp(en), ["jarpeek status"]],
      [whereHelp(en), ["jarpeek where com.example:demo-lib:1.0.0"]],
    ];
    for (const [block, examples] of blocks) {
      expect(block).toContain("Examples:");
      for (const line of examples) {
        expect(block).toContain(line);
      }
      expect(block).toMatch(/^related:/m);
    }
  });

  it("the wiring blocks localize labels but keep their examples", () => {
    expect(mcpHelp(ru)).toContain("Примеры:");
    expect(mcpHelp(ru)).toContain("jarpeek mcp");
    expect(primeHelp(ru)).toContain("Примеры:");
    expect(primeHelp(ru)).toContain("jarpeek prime --full");
    expect(initHelp(ru)).toContain("Примеры:");
    expect(initHelp(ru)).toContain("jarpeek init --yes");
  });

  it("the wiring-command blocks carry their examples", () => {
    expect(mcpHelp(en)).toContain("jarpeek mcp");
    expect(mcpHelp(en)).toContain("init");
    expect(primeHelp(en)).toContain("jarpeek prime --full");
    expect(primeHelp(en)).toContain("jarpeek prime --export");
    expect(initHelp(en)).toContain("jarpeek init --yes");
  });
});

describe("help constants (ru)", () => {
  it("the top level speaks the pinned russian copy with untranslated examples", () => {
    const block = topLevelHelp(ru);
    expect(block).toContain("экономный путь:");
    expect(block).toContain("Примеры:");
    expect(block).toContain("полная шпаргалка для агентов: jarpeek prime --full");
    expect(block).not.toContain("the frugal path:");
    expect(block).toContain("jarpeek find-class StringJoiner --limit 5");
  });

  it("every query-command block keeps examples and gains the ru labels", () => {
    const blocks: Array<[string, string]> = [
      [findClassHelp(ru), "jarpeek find-class StringJoiner --limit 5"],
      [outlineHelp(ru), "jarpeek outline java.util.StringJoiner --kind method"],
      [readMemberHelp(ru), "jarpeek read-member com.example.lib.ApiClient '#builder'"],
      [readSourceHelp(ru), "jarpeek read-source com.example.lib.ApiClient --full"],
      [readResourceHelp(ru), "jarpeek read-resource com.example:demo-lib:1.0.0 'META-INF/**'"],
      [searchSymbolsHelp(ru), "jarpeek search-symbols builder --artifact"],
      [resolveHelp(ru), "jarpeek resolve"],
      [statusHelp(ru), "jarpeek status"],
      [whereHelp(ru), "jarpeek where com.example:demo-lib:1.0.0"],
    ];
    for (const [block, example] of blocks) {
      expect(block).toContain("Примеры:");
      expect(block).toContain(example);
      expect(block).toMatch(/^связанное:/m);
      expect(block).not.toMatch(/^related:/m);
    }
  });
});

describe("help output", () => {
  it("top-level --help lists the --build-tool flag", async () => {
    const { stdout, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--build-tool");
  });

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

describe("help output (--lang ru)", () => {
  it("top-level --lang ru --help speaks russian, examples untranslated", async () => {
    const { stdout, code } = await runCli(["--lang", "ru", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("экономный путь:");
    expect(stdout).toContain("Примеры:");
    expect(stdout).toContain("полная шпаргалка для агентов: jarpeek prime --full");
    expect(stdout).toContain("доступ к исходникам зависимостей");
    expect(stdout).not.toContain("the frugal path:");
    // invocation surface never translates
    expect(stdout).toContain("--lang");
    expect(stdout).toContain("--build-tool");
    expect(stdout).toContain("jarpeek find-class StringJoiner --limit 5");
  });

  it("outline --lang ru --help shows the ru description and untranslated examples", async () => {
    const { stdout, code } = await runCli(["--lang", "ru", "outline", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("скелет класса");
    expect(stdout).toContain("Примеры:");
    expect(stdout).toContain("jarpeek outline java.util.StringJoiner --kind method");
    expect(stdout).toMatch(/^связанное:/m);
  });

  it("an invalid --lang value is a commander choices error", async () => {
    const { stderr, code } = await runCli(["--lang", "fr", "prime"]);
    expect(code).toBe(1);
    expect(stderr).toContain("fr");
    expect(stderr).toContain("en, ru");
  });

  it("config alone flips help: --project into a ru config renders ru", async () => {
    const { stdout, code } = await runCli(["--project", configDir("ru"), "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("экономный путь:");
    expect(stdout).not.toContain("the frugal path:");
  });

  it("the flag beats the config at build time too", async () => {
    const { stdout, code } = await runCli(["--lang", "en", "--project", configDir("ru"), "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("the frugal path:");
    expect(stdout).not.toContain("экономный путь:");
  });
});
