/**
 * Harness wiring: write the jarpeek MCP server entry and the CLI-mode
 * instructions/hook blocks into a harness's config files, idempotently.
 *
 * Every writer compares before it writes, so a second run with the same
 * answers leaves every file byte-identical (`changed:false`, empty
 * actions). JSON files are always parse-validated before write — a merge
 * goes through JSON.parse/stringify, so a wrong key can never corrupt the
 * file. The codex TOML gets a line-oriented editor instead of a parser:
 * foreign lines are preserved byte-for-byte and only the jarpeek section's
 * own lines are ever touched.
 *
 * Verified config schemas (checked against live docs, 2026-08-17):
 * - Claude Code `.mcp.json`: top-level `mcpServers.<name> = {command, args}`.
 *   https://code.claude.com/docs/en/mcp
 * - Claude Code hooks: `.claude/settings.json` → `hooks.SessionStart` is an
 *   array of `{matcher?, hooks: [{type: "command", command, ...}]}`; omitting
 *   the matcher fires on every SessionStart.
 *   https://code.claude.com/docs/en/hooks
 * - Gemini CLI `.gemini/settings.json`: top-level `mcpServers.<name> =
 *   {command, args, ...}`; hooks live under `hooks.SessionStart` — CamelCase,
 *   same event-entry shape as Claude (the plan's guessed `hooks.sessionStart`
 *   casing was wrong and is not used).
 *   https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md
 *   https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md
 * - Qwen Code (Gemini CLI fork): `.qwen/settings.json` with `mcpServers`,
 *   memory file QWEN.md.
 *   https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/
 * - GigaCode: no public schema docs found; treated as a Gemini-CLI-family
 *   fork per plan (`.gigacode/settings.json`, GIGACODE.md) and shares the
 *   gemini code path.
 * - Codex `~/.codex/config.toml`: `[mcp_servers.<name>]` tables with
 *   `command` and `args`. Codex also documents lifecycle hooks inline in
 *   config.toml as `[[hooks.<Event>]]` array-of-tables, including
 *   `SessionStart` — the plan's "codex has no session hooks" assumption is
 *   outdated, so wireCli installs the hook (with a conflict guard below).
 *   https://learn.chatgpt.com/codex/extend/mcp
 *   https://learn.chatgpt.com/codex/hooks
 */
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HarnessDescriptor } from "./descriptors.js";

/** Marker identifying the one instructions line jarpeek owns. */
export const INSTRUCTIONS_MARKER = "<!-- jarpeek -->";

/** The instructions pointer line appended once to each harness's memory file. */
export const INSTRUCTIONS_LINE = `${INSTRUCTIONS_MARKER} dependency-source tooling: run \`jarpeek prime\` for usage`;

/** The session-start hook command: prime's cheatsheet as hook JSON on stdout. */
const hookCommandFor = (command: string): string => `${command} prime --hook-json`;

/** The hooks key every JSON-format harness uses for session-start (see header). */
const SESSION_START_KEY = "SessionStart";

export interface WireMcpOptions {
  /** Executable to register (default "jarpeek"; tests/dev may pass a path). */
  command?: string;
}

export interface WireMcpResult {
  target: string;
  changed: boolean;
}

export interface WireCliOptions {
  command?: string;
}

/** Files wireCli touched this run, as `<kind>:<target>` strings; empty = no-op. */
export interface WireCliResult {
  actions: string[];
}

/**
 * Resolve a descriptor target: `~/` → home, else under the project root.
 * `JARPEEK_HOME` overrides the home directory (same pattern as
 * JARPEEK_CACHE_DIR) so user-scope writes stay testable — without it a test
 * would touch the real `~/.codex/config.toml`.
 */
export function resolveTarget(target: string, projectRoot: string): string {
  const home = process.env.JARPEEK_HOME ?? homedir();
  return target.startsWith("~/") ? join(home, target.slice(2)) : resolve(projectRoot, target);
}

/**
 * The settings.json a harness's session-start hook lives in: claude keeps
 * hooks in `.claude/settings.json` (its MCP entry is a separate `.mcp.json`),
 * the gemini family keeps them in the same settings.json as `mcpServers`.
 */
export function hookSettingsTarget(descriptor: HarnessDescriptor, projectRoot: string): string {
  const rel = descriptor.id === "claude" ? join(".claude", "settings.json") : descriptor.mcp.target;
  return resolveTarget(rel, projectRoot);
}

// -- shared file helpers ---------------------------------------------------------

/** Canonical text form for every JSON file jarpeek writes. */
const jsonText = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

/** Write only when the bytes differ; tmp + rename so readers see whole files. */
async function writeIfChanged(path: string, next: string): Promise<boolean> {
  let prev: string | undefined;
  try {
    prev = await readFile(path, "utf8");
  } catch {
    // absent: fall through and create it
  }
  if (prev === next) return false;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.jarpeek-tmp`;
  await writeFile(tmp, next, "utf8");
  await rename(tmp, path);
  return true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// -- MCP wiring -------------------------------------------------------------------

/**
 * The server entry to register. On win32 the npm bin is `jarpeek.cmd`, which
 * Node-hosted MCP clients cannot spawn without a shell — the entry goes
 * through `cmd /c` instead. (SessionStart hook commands are NOT wrapped:
 * harnesses already run those through a shell.)
 */
function mcpServerEntry(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", command, "mcp"] };
  }
  return { command, args: ["mcp"] };
}

/** Register the jarpeek stdio server in the harness's MCP config. */
export async function wireMcp(
  descriptor: HarnessDescriptor,
  projectRoot: string,
  opts: WireMcpOptions = {},
): Promise<WireMcpResult> {
  const target = resolveTarget(descriptor.mcp.target, projectRoot);
  const command = opts.command ?? "jarpeek";
  const entry = mcpServerEntry(command);
  let changed: boolean;

  if (descriptor.mcp.format === "codex-toml") {
    const text = await readTextOrEmpty(target);
    changed = await writeIfChanged(target, editTomlMcpSection(text, entry));
  } else {
    // mcp-json and settings-json share the shape: set mcpServers.jarpeek,
    // leave every other key (servers, themes, tool config) untouched
    const doc = await readJson(target);
    const servers = isObject(doc.mcpServers) ? doc.mcpServers : {};
    doc.mcpServers = { ...servers, jarpeek: entry };
    changed = await writeIfChanged(target, jsonText(doc));
  }
  return { target, changed };
}

/**
 * Read a JSON object file; missing → {}; unparseable or not an object
 * (scalar/array/null) → throw — the merge path must never clobber a file it
 * could not faithfully round-trip.
 */
async function readJson(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON; refusing to overwrite (${(e as Error).message})`);
  }
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; refusing to overwrite`);
  }
  return parsed;
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

// -- TOML editor --------------------------------------------------------------------

/** A `[table]` or `[[array-of-tables]]` header line, captured without brackets. */
const HEADER_RE =
  /^[ \t]*\[\[([^\]]+)\]\][ \t]*(?:#[^\r\n]*)?\r?$|^[ \t]*\[([^\]]+)\][ \t]*(?:#[^\r\n]*)?\r?$/;

const headerName = (line: string): string | null => {
  const match = HEADER_RE.exec(line);
  if (match === null) return null;
  return (match[1] ?? match[2]).trim();
};

const keyLine = (key: string): RegExp => new RegExp(`^[ \t]*${key}[ \t]*\r?[ \t]*=`);

/** TOML basic-string escaping for the values jarpeek writes. */
const tomlString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Render a TOML array-of-strings value, e.g. `["mcp"]`. */
const tomlStringArray = (values: string[]): string => `[${values.map(tomlString).join(", ")}]`;

/**
 * Set `command`/`args` of `[mcp_servers.jarpeek]`: replace the section's own
 * key lines in place (inserting after the header when missing), or append the
 * whole section at EOF. Every other line is byte-preserved. The file's
 * dominant line ending — CRLF when any `\r\n` is present — is used for the
 * lines this editor writes, so a CRLF config never ends up mixed or with a
 * `\r` stranded inside a header (which would defeat header matching and
 * append a duplicate table).
 */
function editTomlMcpSection(text: string, entry: { command: string; args: string[] }): string {
  const crlf = text.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const fields: Array<[string, string]> = [
    ["command", tomlString(entry.command)],
    ["args", tomlStringArray(entry.args)],
  ];
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) => headerName(line) === "mcp_servers.jarpeek");

  if (headerIndex === -1) {
    let out = text;
    if (out.length > 0) out += out.endsWith("\n") ? eol : eol + eol;
    out +=
      ["[mcp_servers.jarpeek]", ...fields.map(([k, v]) => `${k} = ${v}`)].join(eol) + eol;
    return out;
  }

  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (headerName(lines[i]) !== null) {
      end = i;
      break;
    }
  }
  const pending = new Map(fields);
  for (let i = headerIndex + 1; i < end; i++) {
    for (const [key, value] of fields) {
      if (pending.has(key) && keyLine(key).test(lines[i])) {
        lines[i] = `${key} = ${value}${lines[i]!.endsWith("\r") ? "\r" : ""}`;
        pending.delete(key);
      }
    }
  }
  if (pending.size > 0) {
    const insertions = [...pending.entries()].map(([k, v]) => `${k} = ${v}${crlf ? "\r" : ""}`);
    lines.splice(end, 0, ...insertions);
  }
  return lines.join("\n");
}

// -- CLI wiring -----------------------------------------------------------------------

/** Append the pointer line once; the marker makes re-appends impossible. */
async function appendInstructions(path: string, label: string): Promise<string | null> {
  let text = await readTextOrEmpty(path);
  if (text.includes(INSTRUCTIONS_MARKER)) return null;
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  text += `${INSTRUCTIONS_LINE}\n`;
  await writeIfChanged(path, text);
  return `instructions:${label}`;
}

/** Merge our entry into `hooks.SessionStart` without touching existing entries. */
async function mergeJsonSessionStartHook(path: string, hookCommand: string): Promise<boolean> {
  const doc = await readJson(path);
  const hooks = isObject(doc.hooks) ? doc.hooks : {};
  const entries = Array.isArray(hooks[SESSION_START_KEY]) ? hooks[SESSION_START_KEY] : [];

  const carriesOurs = (entry: unknown): boolean =>
    isObject(entry) &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => isObject(h) && h.command === hookCommand);
  if (!entries.some(carriesOurs)) {
    hooks[SESSION_START_KEY] = [...entries, { hooks: [{ type: "command", command: hookCommand }] }];
    doc.hooks = hooks;
  }
  return writeIfChanged(path, jsonText(doc));
}

/**
 * Append a `[[hooks.SessionStart]]` block to codex's config.toml. Skipped
 * (without writing) when the command is already present, or when an inline
 * `SessionStart = ...` key exists — appending an array-of-tables next to a
 * plain key assignment would produce invalid TOML.
 */
async function appendCodexTomlHook(path: string, hookCommand: string): Promise<boolean> {
  const text = await readTextOrEmpty(path);
  if (text.includes(tomlString(hookCommand))) return false;
  if (/^[ \t]*SessionStart[ \t]*=/m.test(text)) return false;
  let out = text;
  if (out.length > 0) out += out.endsWith("\n") ? "\n" : "\n\n";
  out +=
    [
      "[[hooks.SessionStart]]",
      "[[hooks.SessionStart.hooks]]",
      'type = "command"',
      `command = ${tomlString(hookCommand)}`,
    ].join("\n") + "\n";
  return writeIfChanged(path, out);
}

/** Wire the CLI consumption path: pointer line plus session-start hook. */
export async function wireCli(
  descriptor: HarnessDescriptor,
  projectRoot: string,
  opts: WireCliOptions = {},
): Promise<WireCliResult> {
  const command = opts.command ?? "jarpeek";
  const actions: string[] = [];

  const instructions = await appendInstructions(
    join(projectRoot, descriptor.instructionsFile),
    descriptor.instructionsFile,
  );
  if (instructions !== null) actions.push(instructions);

  if (descriptor.supportsSessionStartHook) {
    if (descriptor.mcp.format === "codex-toml") {
      const target = resolveTarget(descriptor.mcp.target, projectRoot);
      if (await appendCodexTomlHook(target, hookCommandFor(command))) {
        actions.push(`hook:${descriptor.mcp.target}`);
      }
    } else if (await mergeJsonSessionStartHook(hookSettingsTarget(descriptor, projectRoot), hookCommandFor(command))) {
      actions.push(`hook:${descriptor.id === "claude" ? join(".claude", "settings.json") : descriptor.mcp.target}`);
    }
  }
  return { actions };
}

// -- project guards ----------------------------------------------------------------------

/** Ensure `.jarpeek/` is ignored exactly once; true when a line was added. */
export async function ensureGitignoreJarpeek(projectRoot: string): Promise<boolean> {
  const path = join(projectRoot, ".gitignore");
  const text = await readTextOrEmpty(path);
  if (text.split("\n").some((line) => line.trim() === ".jarpeek/")) return false;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  await writeIfChanged(path, `${text}${separator}.jarpeek/\n`);
  return true;
}
