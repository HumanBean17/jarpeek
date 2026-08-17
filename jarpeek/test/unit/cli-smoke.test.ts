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

  it("stubbed subcommands (init until Task 22) exit 1 with not implemented on stderr", async () => {
    const { stderr, code } = await runCli(["init"]);
    expect(code).toBe(1);
    expect(stderr).toContain("not implemented");
  });
});
