/**
 * The init flow: detect the project, ask which harnesses to wire and how,
 * and write the configs. Nothing resolves or indexes here — the first query
 * pays for resolution (or `jarpeek resolve` does it eagerly).
 *
 * Everything user-facing is injected: PromptIo wraps @clack/prompts (tests
 * replay fixed answers), and the seams accept fakes so the flow never
 * shells out to gradle or touches the JDK in tests. All writes go through
 * the idempotent wiring helpers, so re-running init with the same answers
 * changes nothing.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as clack from "@clack/prompts";
import { HARNESSES, type HarnessDescriptor, type HarnessId } from "./descriptors.js";
import { ensureGitignoreJarpeek, hookSettingsTarget, resolveTarget, wireCli, wireMcp } from "./wiring.js";
import { detectBuildSystems, type BuildSystem, type ResolveDependenciesOptions } from "../resolver/index.js";
import { resolveJdk } from "../resolver/jdk.js";
import { ensureGradleInitScript } from "../resolver/gradle-init.js";
import { commandOnPath } from "../util/path-probe.js";
import { PRIME_CONFIG_PATH } from "../prime/command.js";

/** The prompts init asks; the real implementation is @clack/prompts. */
export interface PromptIo {
  multiselect(message: string, choices: string[], defaults?: string[]): Promise<string[]>;
  select(message: string, choices: string[], dflt?: string): Promise<string>;
  confirm(message: string, dflt: boolean): Promise<boolean>;
}

/** Seams injectable per call. */
export interface InitResolvers extends ResolveDependenciesOptions {
  detectBuildSystems?: typeof detectBuildSystems;
  ensureGradleInitScript?: typeof ensureGradleInitScript;
  /** PATH probe for the wired command; defaults to the real one. */
  commandOnPath?: typeof commandOnPath;
}

export interface InitOptions {
  prompts?: PromptIo;
  resolvers?: InitResolvers;
  /** Executable to register in harness configs (default "jarpeek"). */
  command?: string;
  /** Non-interactive defaults: claude + mcp (the CLI's --yes). */
  yes?: boolean;
}

export interface InitResult {
  detected: { buildSystems: BuildSystem[]; jdk: string | null };
  wired: Array<{ harness: string; mode: string; targets: string[] }>;
  notes: string[];
}

const NOTE_NON_INTERACTIVE = "non-interactive: defaults applied";
/** Where resolution moved to: the first query, or the explicit command. */
const NOTE_AUTO_RESOLVE = "first query auto-resolves (or run: jarpeek resolve)";
/** The npx trap: configs invoke `jarpeek`, which only exists once installed. */
const NOTE_NOT_ON_PATH = (command: string): string =>
  `'${command}' not on PATH — installed configs invoke it; run npm install -g jarpeek`;

/** The @clack/prompts adapter; Ctrl-C at any prompt exits cleanly. */
function clackPromptIo(): PromptIo {
  const guard = <T>(value: T): T => {
    if (clack.isCancel(value)) {
      clack.cancel("init cancelled");
      process.exit(0);
    }
    return value;
  };
  return {
    multiselect: async (message, choices, defaults) =>
      guard(
        await clack.multiselect({
          message,
          options: choices.map((value) => ({ value, label: value })),
          initialValues: defaults ?? [],
          required: true,
        }),
      ) as string[],
    select: async (message, choices, dflt) =>
      guard(
        await clack.select({
          message,
          options: choices.map((value) => ({ value, label: value })),
          initialValue: dflt,
        }),
      ) as string,
    confirm: async (message, dflt) =>
      guard(await clack.confirm({ message, initialValue: dflt })) as boolean,
  };
}

/** Does the descriptor's MCP target already hold a jarpeek block? */
function hasExistingBlock(descriptor: HarnessDescriptor, projectRoot: string): boolean {
  const target = resolveTarget(descriptor.mcp.target, projectRoot);
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return false;
  }
  if (descriptor.mcp.format === "codex-toml") {
    return /^[ \t]*\[mcp_servers\.jarpeek\]/m.test(text);
  }
  try {
    return Object.prototype.hasOwnProperty.call(JSON.parse(text).mcpServers ?? {}, "jarpeek");
  } catch {
    return false;
  }
}

/** Record the wired mode where prime's auto-detect reads it. */
async function writePrimeMode(projectRoot: string, mode: "mcp" | "cli"): Promise<void> {
  const path = join(projectRoot, PRIME_CONFIG_PATH);
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) doc = parsed as Record<string, unknown>;
  } catch {
    // absent or corrupt (a corrupt config.json is ours to replace)
  }
  doc.primeMode = mode;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

/** The targets one harness wiring touches, for InitResult.wired. */
function wiringTargets(descriptor: HarnessDescriptor, projectRoot: string, mode: string): string[] {
  if (mode === "mcp") return [resolveTarget(descriptor.mcp.target, projectRoot)];
  const targets = [join(projectRoot, descriptor.instructionsFile)];
  if (descriptor.supportsSessionStartHook) {
    targets.push(
      descriptor.mcp.format === "codex-toml"
        ? resolveTarget(descriptor.mcp.target, projectRoot)
        : hookSettingsTarget(descriptor, projectRoot),
    );
  }
  return targets;
}

/**
 * Run the init flow over `projectRoot`. Interactive when prompts are injected
 * or stdout is a TTY (and `yes` is not set); otherwise defaults apply. Never
 * throws for missing build systems or JDK — those become `detected` facts and
 * notes.
 */
export async function runInit(projectRoot: string, opts: InitOptions = {}): Promise<InitResult> {
  const notes: string[] = [];
  const resolvers = opts.resolvers ?? {};
  const wired: InitResult["wired"] = [];

  const buildSystems = (resolvers.detectBuildSystems ?? detectBuildSystems)(projectRoot);
  const jdkOutcome = await (resolvers.jdk ?? resolveJdk)();
  const jdk = jdkOutcome.artifact !== null ? jdkOutcome.artifact.coordinates.replace(/^jdk:/, "") : null;
  notes.push(...jdkOutcome.warnings.map((warning) => `jdk: ${warning}`));

  const existing = HARNESSES.filter((d) => hasExistingBlock(d, projectRoot)).map((d) => d.id);
  if (existing.length > 0) notes.push(`existing jarpeek config: ${existing.join(", ")}`);

  const interactive = opts.yes !== true && (opts.prompts !== undefined || process.stdout.isTTY === true);
  let harnessIds: HarnessId[];
  let mode: "mcp" | "cli";
  if (interactive) {
    const prompts = opts.prompts ?? clackPromptIo();
    const ids = HARNESSES.map((d) => d.id);
    const chosen = await prompts.multiselect("Which AI harnesses should jarpeek wire?", ids, ["claude"]);
    harnessIds = ids.filter((id) => chosen.includes(id));
    if (harnessIds.length === 0) {
      harnessIds = ["claude"];
      notes.push("no harness selected; defaulting to claude");
    }
    mode = (await prompts.select("Wire as MCP server or CLI hints?", ["mcp", "cli"], "mcp")) === "cli" ? "cli" : "mcp";
  } else {
    harnessIds = ["claude"];
    mode = "mcp";
    notes.push(NOTE_NON_INTERACTIVE);
  }

  for (const id of harnessIds) {
    const descriptor = HARNESSES.find((d) => d.id === id);
    if (descriptor === undefined) continue;
    if (mode === "mcp") await wireMcp(descriptor, projectRoot, { command: opts.command });
    else await wireCli(descriptor, projectRoot, { command: opts.command });
    wired.push({ harness: id, mode, targets: wiringTargets(descriptor, projectRoot, mode) });
  }
  if (mode === "mcp") await writePrimeMode(projectRoot, "mcp");

  // the configs invoke the command by bare name: if it is not on PATH the
  // wiring is dead on arrival (the classic npx-first-run trap)
  const command = opts.command ?? "jarpeek";
  const onPath = resolvers.commandOnPath ?? commandOnPath;
  if (!/[\\/]/.test(command) && !onPath(command)) {
    notes.push(NOTE_NOT_ON_PATH(command));
  }

  if (await ensureGitignoreJarpeek(projectRoot)) notes.push("added .jarpeek/ to .gitignore");
  if (buildSystems.includes("gradle")) {
    const script = await (resolvers.ensureGradleInitScript ?? ensureGradleInitScript)(projectRoot);
    notes.push(`gradle init script: ${script}`);
  }

  notes.push(NOTE_AUTO_RESOLVE);

  return { detected: { buildSystems, jdk }, wired, notes };
}
