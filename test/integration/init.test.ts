/**
 * init flow integration tests: runInit with injected prompts and resolvers
 * over tmp projects (a build.gradle marker makes the real cascade inside
 * resolveDependencies take the injected gradle resolver). init no longer
 * indexes anything: it wires harnesses and hands resolution to the first
 * query (or `jarpeek resolve`). Every scenario ends in the idempotency
 * check the init contract promises: same answers, zero byte changes.
 *
 * The first suites pin `scope: "project"` (configs written into the repo);
 * the machine-wide suite at the end covers init's default.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit, type InitResolvers, type PromptIo } from "../../src/harness/init.js";
import type { ClaudeCli } from "../../src/harness/wiring.js";
import { defaultPrimeContent } from "../../src/prime/content.js";
import { prime } from "../../src/prime/command.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const roots: string[] = [];

/** A tmp project root carrying a gradle marker so detection and the cascade agree. */
function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarpeek-init-"));
  roots.push(dir);
  writeFileSync(join(dir, "build.gradle"), "plugins { id 'java' }\n");
  return dir;
}

/** Resolvers that answer instantly; nothing resolves unless a query asks. */
function fakeResolvers(commandOnPathResult = true): InitResolvers {
  return {
    jdk: async () => ({ artifact: null, warnings: [] }),
    commandOnPath: () => commandOnPathResult,
  };
}

/** The server entry wiring registers on this platform (win32 wraps cmd /c). */
const SERVER_ENTRY =
  process.platform === "win32"
    ? { command: "cmd", args: ["/c", "jarpeek", "mcp"] }
    : { command: "jarpeek", args: ["mcp"] };

/** PromptIo replaying fixed answers (text prompts left empty — no root pin). */
function fakePrompts(answers: { harnesses?: string[]; mode?: "mcp" | "cli" }): PromptIo {
  return {
    multiselect: async () => answers.harnesses ?? ["claude"],
    select: async () => answers.mode ?? "mcp",
    confirm: async () => true,
    text: async () => "",
  };
}

/** SHA-256 of every existing path in the list, for before/after comparison. */
function hashAll(root: string, rels: string[]): string {
  const parts: string[] = [];
  for (const rel of rels) {
    const path = join(root, rel);
    parts.push(existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "-");
  }
  return parts.join("|");
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("interactive mcp wiring", () => {
  it("wires claude and gemini, writes primeMode, and resolves nothing", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project",
      prompts: fakePrompts({ harnesses: ["claude", "gemini"], mode: "mcp" }),
      resolvers: fakeResolvers(),
    });

    expect(result.detected.buildSystems).toEqual(["gradle"]);
    expect(result.detected.jdk).toBeNull();
    expect(result.wired.map((w) => w.harness)).toEqual(["claude", "gemini"]);
    expect(result.wired.every((w) => w.mode === "mcp")).toBe(true);

    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.jarpeek).toEqual(SERVER_ENTRY);
    const gemini = JSON.parse(readFileSync(join(root, ".gemini", "settings.json"), "utf8"));
    expect(gemini.mcpServers.jarpeek).toEqual(SERVER_ENTRY);

    expect(JSON.parse(readFileSync(join(root, ".jarpeek", "config.json"), "utf8"))).toEqual({
      primeMode: "mcp",
    });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".jarpeek/");
    expect(existsSync(join(root, ".jarpeek", "manifest.json"))).toBe(false);
    // the gradle init script lives in the machine-wide cache, written by the first resolve
    expect(existsSync(join(root, ".jarpeek", "gradle-init.gradle"))).toBe(false);
    // the index prompt and the index call are both gone
    expect(result.notes.some((note) => note.includes("indexed"))).toBe(false);
    expect(result.notes).toContain("first query auto-resolves (or run: jarpeek resolve)");
  });

  it("prime() serves the short mcp card after init (config.json source)", async () => {
    const root = tmpProject();
    await runInit(root, { scope: "project",
      prompts: fakePrompts({ harnesses: ["claude"], mode: "mcp" }),
      resolvers: fakeResolvers(),
    });
    try {
      vi.stubEnv("JARPEEK_PRIME_MODE", undefined); // config.json must carry the mode alone
      expect(prime(root)).toEqual({ text: defaultPrimeContent("mcp"), source: "default" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("cli wiring", () => {
  it("wires the instructions pointer and hook, no mcp entry", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project",
      prompts: fakePrompts({ harnesses: ["claude"], mode: "cli" }),
      resolvers: fakeResolvers(),
    });

    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".jarpeek", "config.json"))).toBe(false);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("<!-- jarpeek -->");
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("jarpeek prime --hook-json");
  });
});

describe("idempotency", () => {
  it("a second run with the same answers changes no target bytes", async () => {
    const root = tmpProject();
    const opts = {
      scope: "project" as const,
      prompts: fakePrompts({ harnesses: ["claude", "gemini"], mode: "mcp" }),
      resolvers: fakeResolvers(),
    };
    const first = await runInit(root, opts);

    const targets = [
      ".mcp.json",
      join(".gemini", "settings.json"),
      join(".jarpeek", "config.json"),
      ".gitignore",
    ];
    const before = hashAll(root, targets);
    const second = await runInit(root, opts);

    expect(hashAll(root, targets)).toBe(before);
    expect(second.wired.map((w) => w.harness)).toEqual(["claude", "gemini"]);

    const settings = JSON.parse(readFileSync(join(root, ".gemini", "settings.json"), "utf8"));
    expect(Object.keys(settings.mcpServers)).toEqual(["jarpeek"]);
    expect(readFileSync(join(root, ".gitignore"), "utf8").match(/\.jarpeek\//g)).toHaveLength(1);
    expect(first.wired).toHaveLength(2);
  });
});

describe("non-interactive", () => {
  it("applies defaults (claude + mcp), resolves nothing, and says so", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project", resolvers: fakeResolvers() });

    expect(result.notes).toContain("non-interactive: defaults applied");
    expect(result.wired).toEqual([
      { harness: "claude", mode: "mcp", targets: [join(root, ".mcp.json")] },
    ]);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.jarpeek.command).toBe(
      SERVER_ENTRY.command,
    );
    expect(existsSync(join(root, ".jarpeek", "manifest.json"))).toBe(false);
    expect(result.notes).toContain("first query auto-resolves (or run: jarpeek resolve)");
  });
});

describe("command PATH check (the npx-first-run trap)", () => {
  it("notes that the wired command is not on PATH when the probe misses", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project", resolvers: fakeResolvers(false) });

    expect(result.notes).toContain(
      "'jarpeek' not on PATH — installed configs invoke it; run npm install -g jarpeek",
    );
  });

  it("stays silent when the command is on PATH or is an explicit path", async () => {
    const onPath = await runInit(tmpProject(), { scope: "project", resolvers: fakeResolvers(true) });
    expect(onPath.notes.some((n) => n.includes("not on PATH"))).toBe(false);

    const explicit = await runInit(tmpProject(), { scope: "project",
      resolvers: fakeResolvers(false),
      command: "/usr/local/bin/jarpeek",
    });
    expect(explicit.notes.some((n) => n.includes("not on PATH"))).toBe(false);
  });
});

describe("cache-root advanced step", () => {
  /** fakePrompts extended with the two text answers, capturing placeholders. */
  function rootPrompts(answers: { m2Dir?: string; gradleCacheDir?: string }): PromptIo & {
    placeholders: string[];
  } {
    const placeholders: string[] = [];
    const base = fakePrompts({ harnesses: ["claude"], mode: "mcp" });
    return {
      ...base,
      placeholders,
      text: async (message: string, placeholder?: string) => {
        placeholders.push(placeholder ?? "");
        return message.includes("Maven") ? answers.m2Dir ?? "" : answers.gradleCacheDir ?? "";
      },
    };
  }

  /** Resolvers plus an effectiveRoots seam pinning detection off the machine. */
  function rootResolvers(m2: string): InitResolvers {
    return {
      ...fakeResolvers(),
      effectiveRoots: () => ({
        m2: [{ path: m2, source: "settings" }],
        gradle: { path: "/detected/gradle", source: "default" },
      }),
    };
  }

  it("persists an explicit m2 override and notes it", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project",
      prompts: rootPrompts({ m2Dir: "/pinned/m2" }),
      resolvers: rootResolvers("/detected/m2"),
    });

    const config = JSON.parse(readFileSync(join(root, ".jarpeek", "config.json"), "utf8"));
    expect(config.m2Dir).toBe("/pinned/m2");
    expect(config.gradleCacheDir).toBeUndefined();
    expect(config.primeMode).toBe("mcp");
    expect(result.notes.some((n) => n.includes("cache roots pinned"))).toBe(true);
  });

  it("empty answers omit the fields and add no note", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project",
      prompts: rootPrompts({}),
      resolvers: rootResolvers("/detected/m2"),
    });

    const config = JSON.parse(readFileSync(join(root, ".jarpeek", "config.json"), "utf8"));
    expect(config.m2Dir).toBeUndefined();
    expect(config.gradleCacheDir).toBeUndefined();
    expect(result.notes.some((n) => n.includes("cache roots pinned"))).toBe(false);
  });

  it("the non-interactive path skips the step entirely", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project", yes: true, resolvers: rootResolvers("/detected/m2") });

    const config = JSON.parse(readFileSync(join(root, ".jarpeek", "config.json"), "utf8"));
    expect(config.m2Dir).toBeUndefined();
    expect(result.notes.some((n) => n.includes("cache roots pinned"))).toBe(false);
  });

  it("shows the detected root as the prompt placeholder", async () => {
    const root = tmpProject();
    const prompts = rootPrompts({});
    await runInit(root, { scope: "project", prompts, resolvers: rootResolvers("/detected/m2") });

    expect(prompts.placeholders.some((p) => p.includes("/detected/m2"))).toBe(true);
  });

  it("a second run with the same override changes no target bytes", async () => {
    const root = tmpProject();
    const opts = {
      scope: "project" as const,
      prompts: rootPrompts({ m2Dir: "/pinned/m2" }),
      resolvers: rootResolvers("/detected/m2"),
    };
    await runInit(root, opts);

    const target = join(".jarpeek", "config.json");
    const before = hashAll(root, [target]);
    await runInit(root, opts);

    expect(hashAll(root, [target])).toBe(before);
    const config = JSON.parse(readFileSync(join(root, target), "utf8"));
    expect(config.m2Dir).toBe("/pinned/m2");
  });

  it("rejects a non-absolute answer with an honest note instead of a dead pin", async () => {
    const root = tmpProject();
    const result = await runInit(root, { scope: "project",
      prompts: rootPrompts({ m2Dir: "~/m2" }),
      resolvers: rootResolvers("/detected/m2"),
    });

    const config = JSON.parse(readFileSync(join(root, ".jarpeek", "config.json"), "utf8"));
    expect(config.m2Dir).toBeUndefined();
    expect(result.notes.some((n) => n.includes("not an absolute path — not pinned: ~/m2"))).toBe(true);
    expect(result.notes.some((n) => n.includes("cache roots pinned"))).toBe(false);
  });
});

describe("machine-wide (the default scope)", () => {
  /** A scratch home, and a fake `claude` CLI recording its calls and keeping ~/.claude.json like the real one. */
  function machine(): { home: string; calls: string[][]; cli: ClaudeCli } {
    const home = mkdtempSync(join(tmpdir(), "jarpeek-init-home-"));
    roots.push(home);
    vi.stubEnv("JARPEEK_HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    const calls: string[][] = [];
    const cli: ClaudeCli = {
      run(args) {
        calls.push(args);
        if (args[1] === "add") {
          const [command, ...rest] = args.slice(args.indexOf("--") + 1);
          writeFileSync(
            join(home, ".claude.json"),
            JSON.stringify({ mcpServers: { jarpeek: { type: "stdio", command, args: rest, env: {} } } }),
          );
        }
        return { ok: true, output: "" };
      },
    };
    return { home, calls, cli };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mcp: claude through `claude mcp add --scope user`, gemini in ~/.gemini; nothing in the project", async () => {
    const { home, calls, cli } = machine();
    const root = tmpProject();
    const result = await runInit(root, {
      prompts: fakePrompts({ harnesses: ["claude", "gemini"], mode: "mcp" }),
      resolvers: { ...fakeResolvers(), claudeCli: cli },
    });

    expect(result.scope).toBe("user");
    expect(calls).toEqual([["mcp", "add", "--scope", "user", "jarpeek", "--", SERVER_ENTRY.command, ...SERVER_ENTRY.args]]);
    expect(JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).mcpServers.jarpeek).toEqual(SERVER_ENTRY);
    expect(JSON.parse(readFileSync(join(home, ".config", "jarpeek", "config.json"), "utf8"))).toEqual({ primeMode: "mcp" });
    expect(result.wired.map((w) => [w.harness, w.targets])).toEqual([
      ["claude", [join(home, ".claude.json")]],
      ["gemini", [join(home, ".gemini", "settings.json")]],
    ]);
    for (const rel of [".mcp.json", ".gemini", ".jarpeek", ".gitignore"]) expect(existsSync(join(root, rel))).toBe(false);
    expect(result.notes.some((n) => n.startsWith("machine-wide:"))).toBe(true);

    // idempotent: the same entry is already there, so claude is not called again
    await runInit(root, {
      prompts: fakePrompts({ harnesses: ["claude", "gemini"], mode: "mcp" }),
      resolvers: { ...fakeResolvers(), claudeCli: cli },
    });
    expect(calls).toHaveLength(1);
  });

  it("a different existing claude entry is replaced (remove, then add)", async () => {
    const { home, calls, cli } = machine();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { jarpeek: { command: "npx", args: ["jarpeek", "mcp"] } } }));
    await runInit(tmpProject(), { yes: true, resolvers: { ...fakeResolvers(), claudeCli: cli } });
    expect(calls.map((c) => c[1])).toEqual(["remove", "add"]);
  });

  it("without a usable claude CLI, the exact command is the answer — nothing claims to be wired", async () => {
    machine();
    const result = await runInit(tmpProject(), { yes: true, resolvers: { ...fakeResolvers(), claudeCli: null } });
    expect(result.wired).toEqual([]);
    expect(result.notes).toContain(
      `claude: not wired automatically — run: claude mcp add --scope user jarpeek -- ${[SERVER_ENTRY.command, ...SERVER_ENTRY.args].join(" ")}`,
    );
  });

  it("cli mode: user-level instructions and SessionStart hooks", async () => {
    const { home } = machine();
    const result = await runInit(tmpProject(), {
      prompts: fakePrompts({ harnesses: ["claude", "codex"], mode: "cli" }),
      resolvers: fakeResolvers(),
    });
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("<!-- jarpeek --> Gradle/Maven projects");
    expect(
      JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.SessionStart[0].hooks[0].command,
    ).toBe("jarpeek prime --hook-json");
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toContain("<!-- jarpeek -->");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[[hooks.SessionStart]]");
    expect(result.wired.map((w) => w.harness)).toEqual(["claude", "codex"]);
  });

  it("cache-root pins go to the machine-wide config", async () => {
    const { home } = machine();
    const prompts: PromptIo = {
      ...fakePrompts({ harnesses: ["claude"], mode: "mcp" }),
      text: async (message: string) => (message.includes("Maven") ? "/pinned/m2" : ""),
    };
    await runInit(tmpProject(), { prompts, resolvers: { ...fakeResolvers(), claudeCli: null } });
    expect(JSON.parse(readFileSync(join(home, ".config", "jarpeek", "config.json"), "utf8")).m2Dir).toBe("/pinned/m2");
  });

  it("names a project-scoped entry that would shadow the machine-wide one", async () => {
    machine();
    const root = tmpProject();
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { jarpeek: { command: "jarpeek", args: ["mcp"] } } }));
    const result = await runInit(root, { yes: true, resolvers: { ...fakeResolvers(), claudeCli: null } });
    expect(result.notes.some((n) => n.startsWith("project-scoped jarpeek config in .mcp.json"))).toBe(true);
  });
});
