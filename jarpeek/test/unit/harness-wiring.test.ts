/**
 * Harness wiring unit tests: the three MCP config formats (mcp-json,
 * settings-json, codex-toml), the CLI-mode instructions pointer and
 * SessionStart hook merges, and the .gitignore guard — all over tmp roots,
 * every case idempotent by second-run byte comparison.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HARNESSES, type HarnessDescriptor } from "../../src/harness/descriptors.js";
import {
  ensureGitignoreJarpeek,
  INSTRUCTIONS_LINE,
  INSTRUCTIONS_MARKER,
  resolveTarget,
  wireCli,
  wireMcp,
} from "../../src/harness/wiring.js";

const roots: string[] = [];

/** A tmp project root with optional pre-seeded relative files. */
function tmpProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-harness-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/** The jarpeek server entry every format must express. */
const JARPEEK_SERVER = { command: "jarpeek", args: ["mcp"] };

function byId(id: HarnessDescriptor["id"]): HarnessDescriptor {
  const found = HARNESSES.find((d) => d.id === id);
  if (found === undefined) throw new Error(`no descriptor for ${id}`);
  return found;
}

/**
 * A fake $HOME under tmp, pinned via JARPEEK_HOME so the user-scope codex
 * target never hits the real `~/.codex`.
 */
function codexHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "jarpeek-codex-home-")), "fakehome");
  roots.push(dirname(home));
  mkdirSync(join(home, ".codex"), { recursive: true });
  process.env.JARPEEK_HOME = home;
  return home;
}

afterAll(() => {
  delete process.env.JARPEEK_HOME; // codex tests point it at tmp fake homes
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("descriptor table", () => {
  it("covers the five harnesses with the planned targets", () => {
    expect(HARNESSES.map((d) => d.id)).toEqual(["claude", "codex", "gemini", "qwen", "gigacode"]);
    expect(HARNESSES.map((d) => d.mcp.target)).toEqual([
      ".mcp.json",
      "~/.codex/config.toml",
      ".gemini/settings.json",
      ".qwen/settings.json",
      ".gigacode/settings.json",
    ]);
    expect(HARNESSES.map((d) => d.instructionsFile)).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      "GEMINI.md",
      "QWEN.md",
      "GIGACODE.md",
    ]);
  });

  it("resolves project targets under the root and ~ targets under the configured home", () => {
    const root = tmpProject();
    expect(resolveTarget(".mcp.json", root)).toBe(join(root, ".mcp.json"));
    process.env.JARPEEK_HOME = join(root, "fakehome");
    try {
      expect(resolveTarget("~/.codex/config.toml", root)).toBe(
        join(root, "fakehome", ".codex", "config.toml"),
      );
    } finally {
      delete process.env.JARPEEK_HOME;
    }
  });
});

describe("wireMcp: mcp-json (claude)", () => {
  it("merges into an existing .mcp.json preserving other servers", async () => {
    const root = tmpProject({
      ".mcp.json": JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2),
    });
    const first = await wireMcp(byId("claude"), root);
    expect(first.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.jarpeek).toEqual(JARPEEK_SERVER);

    const before = readFileSync(join(root, ".mcp.json"), "utf8");
    const second = await wireMcp(byId("claude"), root);
    expect(second.changed).toBe(false);
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe(before);
  });

  it("creates the file in a fresh directory", async () => {
    const root = tmpProject();
    const result = await wireMcp(byId("claude"), root);
    expect(result.changed).toBe(true);
    expect(result.target).toBe(join(root, ".mcp.json"));
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.jarpeek).toEqual(
      JARPEEK_SERVER,
    );
  });

  it("honors a command override", async () => {
    const root = tmpProject();
    await wireMcp(byId("claude"), root, { command: "npx" });
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.jarpeek.command).toBe(
      "npx",
    );
  });
});

describe("wireMcp: settings-json (gemini family)", () => {
  it("preserves unrelated top-level settings keys", async () => {
    const root = tmpProject({
      ".gemini/settings.json": JSON.stringify({ theme: "dark", mcpServers: { keep: { command: "k" } } }),
    });
    const first = await wireMcp(byId("gemini"), root);
    expect(first.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(join(root, ".gemini", "settings.json"), "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.keep).toEqual({ command: "k" });
    expect(parsed.mcpServers.jarpeek).toEqual(JARPEEK_SERVER);

    const before = readFileSync(join(root, ".gemini", "settings.json"), "utf8");
    expect((await wireMcp(byId("gemini"), root)).changed).toBe(false);
    expect(readFileSync(join(root, ".gemini", "settings.json"), "utf8")).toBe(before);
  });

  it("creates .qwen/settings.json for the factory-generated rows", async () => {
    const root = tmpProject();
    await wireMcp(byId("qwen"), root);
    await wireMcp(byId("gigacode"), root);
    for (const dir of [".qwen", ".gigacode"]) {
      expect(JSON.parse(readFileSync(join(root, dir, "settings.json"), "utf8")).mcpServers.jarpeek).toEqual(
        JARPEEK_SERVER,
      );
    }
  });
});

describe("wireMcp: codex-toml", () => {
  const PRE = [
    "# my config",
    '[mcp_servers.other]',
    'command = "uvx"',
    'args = ["other-tool"]',
    "",
    "[profile.x]",
    'editor = "vim"',
    "",
  ].join("\n");

  it("appends the jarpeek section and byte-preserves foreign sections", async () => {
    const home = codexHome();
    writeFileSync(join(home, ".codex", "config.toml"), PRE);

    const result = await wireMcp(byId("codex"), home);
    expect(result.target).toBe(join(home, ".codex", "config.toml"));
    expect(result.changed).toBe(true);
    const text = readFileSync(result.target, "utf8");
    expect(text).toContain("[mcp_servers.jarpeek]");
    expect(text).toContain('command = "jarpeek"');
    expect(text).toContain('args = ["mcp"]');
    // every original line survives verbatim
    for (const line of PRE.split("\n")) expect(text).toContain(line === "" ? "\n" : line);

    const before = readFileSync(result.target, "utf8");
    expect((await wireMcp(byId("codex"), home)).changed).toBe(false);
    expect(readFileSync(result.target, "utf8")).toBe(before);
  });

  it("replaces command/args of an existing jarpeek section in place", async () => {
    const home = codexHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const existing = [
      '[mcp_servers.jarpeek]',
      'command = "old"',
      'args = ["old-mode"]',
      "",
      "[profile.x]",
      'editor = "vim"',
      "",
    ].join("\n");
    writeFileSync(join(home, ".codex", "config.toml"), existing);
    await wireMcp(byId("codex"), home);
    const text = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(text).not.toContain('command = "old"');
    expect(text).toContain('command = "jarpeek"');
    // the later foreign section is untouched
    expect(text).toContain('[profile.x]');
    expect(text).toContain('editor = "vim"');
  });
});

describe("wireCli: instructions pointer", () => {
  it("appends the marker line once to an existing instructions file", async () => {
    const root = tmpProject({ "CLAUDE.md": "# Project\n\nSome docs.\n" });
    const first = await wireCli(byId("claude"), root);
    expect(first.actions.length).toBeGreaterThan(0);
    const text = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(text.startsWith("# Project\n\nSome docs.\n")).toBe(true);
    expect(text).toContain(INSTRUCTIONS_LINE);

    const before = readFileSync(join(root, "CLAUDE.md"), "utf8");
    const second = await wireCli(byId("claude"), root);
    expect(second.actions).toEqual([]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(before);
  });

  it("never appends when any line already carries the marker", async () => {
    const original = `keep me\n${INSTRUCTIONS_MARKER} custom phrasing\n`;
    const home = codexHome();
    writeFileSync(join(home, "AGENTS.md"), original);
    const config = join(home, ".codex", "config.toml");
    writeFileSync(config, '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "jarpeek prime --hook-json"\n');
    const originalToml = readFileSync(config, "utf8");

    const result = await wireCli(byId("codex"), home);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(original);
    expect(readFileSync(config, "utf8")).toBe(originalToml);
    expect(result.actions).toEqual([]);
  });

  it("creates the instructions file when absent", async () => {
    const root = tmpProject();
    await wireCli(byId("gemini"), root);
    expect(readFileSync(join(root, "GEMINI.md"), "utf8")).toBe(`${INSTRUCTIONS_LINE}\n`);
  });
});

describe("wireCli: SessionStart hooks", () => {
  it("claude: appends alongside an existing hook entry without duplication", async () => {
    const root = tmpProject({
      ".claude/settings.json": JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    });
    await wireCli(byId("claude"), root);
    const parsed = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[0]).toEqual({
      matcher: "startup",
      hooks: [{ type: "command", command: "echo hi" }],
    });
    expect(parsed.hooks.SessionStart[1]).toEqual({
      hooks: [{ type: "command", command: "jarpeek prime --hook-json" }],
    });

    const before = readFileSync(join(root, ".claude", "settings.json"), "utf8");
    await wireCli(byId("claude"), root);
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toBe(before);
    expect(
      JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")).hooks.SessionStart,
    ).toHaveLength(2);
  });

  it("gemini: uses the documented CamelCase SessionStart key in its settings.json", async () => {
    const root = tmpProject();
    await wireCli(byId("gemini"), root);
    const parsed = JSON.parse(readFileSync(join(root, ".gemini", "settings.json"), "utf8"));
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe("jarpeek prime --hook-json");
    // wireCli never touches mcpServers — that is wireMcp's half
    expect(parsed.mcpServers).toBeUndefined();
  });

  it("codex: appends a [[hooks.SessionStart]] block to config.toml, once", async () => {
    const home = codexHome();
    const config = join(home, ".codex", "config.toml");
    writeFileSync(config, '[profile.x]\neditor = "vim"\n');

    await wireCli(byId("codex"), home);
    const text = readFileSync(config, "utf8");
    expect(text).toContain("[[hooks.SessionStart]]");
    expect(text).toContain('command = "jarpeek prime --hook-json"');
    expect(text).toContain('[profile.x]'); // foreign table preserved

    const before = readFileSync(config, "utf8");
    const second = await wireCli(byId("codex"), home);
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(second.actions).toEqual([]);
  });

  it("codex: skips the hook when an inline SessionStart key would conflict", async () => {
    const home = codexHome();
    const config = join(home, ".codex", "config.toml");
    writeFileSync(config, '[hooks]\nSessionStart = []\n');

    const result = await wireCli(byId("codex"), home);
    const text = readFileSync(config, "utf8");
    expect(text).not.toContain("[[hooks.SessionStart]]");
    // the instructions pointer is independent of the hook skip
    expect(result.actions.some((a) => a.startsWith("instructions:"))).toBe(true);
    expect(result.actions.some((a) => a.startsWith("hook:"))).toBe(false);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(`${INSTRUCTIONS_LINE}\n`);
  });
});

describe("gitignore guard", () => {
  it("appends .jarpeek/ once and never duplicates", async () => {
    const root = tmpProject({ ".gitignore": "node_modules\n" });
    expect(await ensureGitignoreJarpeek(root)).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.jarpeek/\n");
    expect(await ensureGitignoreJarpeek(root)).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.jarpeek/\n");
  });

  it("creates a missing .gitignore and respects an existing entry", async () => {
    const fresh = tmpProject();
    expect(await ensureGitignoreJarpeek(fresh)).toBe(true);
    expect(readFileSync(join(fresh, ".gitignore"), "utf8")).toBe(".jarpeek/\n");

    const has = tmpProject({ ".gitignore": "target/\n.jarpeek/\n" });
    expect(await ensureGitignoreJarpeek(has)).toBe(false);
    expect(readFileSync(join(has, ".gitignore"), "utf8")).toBe("target/\n.jarpeek/\n");
  });
});
