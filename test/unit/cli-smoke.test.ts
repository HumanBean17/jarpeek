import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const pkgRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");

const { VERSION } = await import(join(pkgRoot, "src", "version.ts"));

const pkgJson = JSON.parse(
  await readFile(join(pkgRoot, "package.json"), "utf8"),
) as { version: string };

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", "src/cli/index.ts", ...args],
      { cwd: pkgRoot },
    );
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

describe("CLI smoke", () => {
  it("--version prints VERSION from src/version.ts and matches package.json", async () => {
    const { stdout } = await runCli(["--version"]);
    expect(stdout.trim()).toBe(VERSION);
    expect(stdout.trim()).toBe(pkgJson.version);
  });

  it("no args prints help with Usage and subcommands, exit 0", async () => {
    const { stdout, code } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("find-class");
    expect(stdout).toContain("mcp");
  });

  it("init --help exits 0 with its description and --yes (no side effects)", async () => {
    const { stdout, code } = await runCli(["init", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("wire AI harnesses");
    expect(stdout).toContain("--yes");
  });
});

describe("flag value validation", () => {
  it("outline --kind with an invalid value exits 1 naming every choice", async () => {
    const { stdout, stderr, code } = await runCli(["outline", "Foo", "--kind", "methods"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Allowed choices are");
    // first and last of the eleven kinds — the full span is present
    expect(stderr).toContain("method");
    expect(stderr).toContain("enum-constant");
  });

  it("outline --visibility with an invalid value exits 1 naming every choice", async () => {
    const { stderr, code } = await runCli(["outline", "Foo", "--visibility", "publicish"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Allowed choices are");
    expect(stderr).toContain("package");
  });

  it("search-symbols --kind with an invalid value exits 1 naming every choice", async () => {
    const { stderr, code } = await runCli([
      "search-symbols",
      "builder",
      "--artifact",
      "g:a:1",
      "--kind",
      "methods",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("Allowed choices are");
  });

  it("outline --help renders the declared choices in the options table", async () => {
    const { stdout, code } = await runCli(["outline", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("(choices:");
    expect(stdout).toContain("enum-constant");
  });
});
