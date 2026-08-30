/**
 * Cache-root convergence: where the local Maven repository and the Gradle
 * modules-2 cache live on THIS machine — the anchors every resolver and
 * the cache scan parse against.
 *
 * The chain is ordered candidate roots, never a single answer: an explicit
 * override (tests, resolver DI), the jarpeek env vars, maven/gradle's own
 * standard env vars (`M2_REPO`, `GRADLE_USER_HOME`), the project's
 * `.jarpeek/config.json`, the machine-wide `~/.config/jarpeek/config.json`,
 * maven's `settings.xml` `<localRepository>`, and finally the default
 * `~/.m2/repository`. Env deliberately beats config — the same reasoning
 * `strategy.ts` records for `buildTool`: these are hand-authored
 * per-machine facts, and a one-off shell override
 * (`JARPEEK_M2_DIR=/x jarpeek resolve`) must win. Every layer degrades
 * silently (absent, corrupt, relative-pathed) to the next; nothing here
 * throws or writes. `JARPEEK_HOME` relocates only the jarpeek global
 * config — maven's `~/.m2/settings.xml` always reads the real home.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PRIME_CONFIG_PATH } from "../prime/command.js";

/** Where a candidate came from — the layer a `status` row names. */
export type RootSource = "override" | "env" | "config" | "settings" | "default";

export interface RootCandidate {
  path: string;
  source: RootSource;
}

export interface RootsOptions {
  /** Top-precedence single m2 root (resolver `opts.m2Dir` DI). */
  m2Dir?: string;
  /** Top-precedence gradle cache dir (scan `opts.gradleDir` DI). */
  gradleDir?: string;
  /** User settings.xml location; default `<real home>/.m2/settings.xml`. */
  settingsPath?: string;
}

export interface EffectiveRoots {
  /** Ordered candidates; `[0]` is the primary (fingerprinted, scanned). */
  m2: RootCandidate[];
  gradle: RootCandidate;
}

/** A non-empty absolute path — relative config values drop out silently. */
function validAbsolute(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && isAbsolute(trimmed) ? trimmed : undefined;
}

/** `field` of a JSON config document; absent/corrupt/non-absolute → undefined. */
function configField(configPath: string, field: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  const value =
    typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" ? validAbsolute(value) : undefined;
}

/** The machine-wide config; `JARPEEK_HOME` relocates it (test isolation). */
function globalConfigPath(): string {
  return join(process.env.JARPEEK_HOME ?? homedir(), ".config", "jarpeek", "config.json");
}

/**
 * `<localRepository>` of the user settings.xml: the first occurrence wins,
 * `${user.home}` is interpolated, and anything non-absolute or unparseable
 * contributes nothing. Profile-scoped variants and comments are not honored
 * (top-level `localRepository` is the only spelling maven itself moves the
 * repo with here).
 */
function settingsLocalRepository(settingsPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch {
    return undefined;
  }
  const open = text.indexOf("<localRepository>");
  const close = text.indexOf("</localRepository>");
  if (open === -1 || close <= open) return undefined;
  const raw = text.slice(open + "<localRepository>".length, close).trim();
  if (raw.length === 0) return undefined;
  return validAbsolute(raw.replaceAll("${user.home}", homedir()));
}

/** Push a validated candidate unless an earlier layer already named it. */
function push(list: RootCandidate[], path: string | undefined, source: RootSource): void {
  if (path === undefined || list.some((c) => c.path === path)) return;
  list.push({ path, source });
}

/**
 * The ordered m2 candidate roots for one resolution context. The list is
 * never empty — the default anchors last — and config layers participate
 * only when a `projectRoot` is given.
 */
export function effectiveM2Roots(projectRoot: string | undefined, opts: RootsOptions = {}): RootCandidate[] {
  // an explicit override replaces the chain, not tops it — the caller said
  // exactly where to look (tests pin it; the threaded `roots` option does
  // the same for the context)
  const override = validAbsolute(opts.m2Dir);
  if (override !== undefined) return [{ path: override, source: "override" }];
  const list: RootCandidate[] = [];
  push(list, validAbsolute(process.env.JARPEEK_M2_DIR), "env");
  push(list, validAbsolute(process.env.M2_REPO), "env");
  if (projectRoot !== undefined) {
    push(list, configField(join(projectRoot, PRIME_CONFIG_PATH), "m2Dir"), "config");
  }
  push(list, configField(globalConfigPath(), "m2Dir"), "config");
  push(
    list,
    settingsLocalRepository(opts.settingsPath ?? join(homedir(), ".m2", "settings.xml")),
    "settings",
  );
  push(list, join(homedir(), ".m2", "repository"), "default");
  return list;
}

/** The single gradle modules-2 cache root: first valid layer wins. */
export function effectiveGradleCacheRoot(
  projectRoot: string | undefined,
  opts: RootsOptions = {},
): RootCandidate {
  const layers: Array<[string | undefined, RootSource]> = [
    [validAbsolute(opts.gradleDir), "override"],
    [validAbsolute(process.env.JARPEEK_GRADLE_CACHE_DIR), "env"],
    [
      validAbsolute(
        process.env.GRADLE_USER_HOME !== undefined
          ? join(process.env.GRADLE_USER_HOME, "caches", "modules-2", "files-2.1")
          : undefined,
      ),
      "env",
    ],
  ];
  if (projectRoot !== undefined) {
    layers.push([configField(join(projectRoot, PRIME_CONFIG_PATH), "gradleCacheDir"), "config"]);
  }
  layers.push([configField(globalConfigPath(), "gradleCacheDir"), "config"]);
  for (const [path, source] of layers) {
    if (path !== undefined) return { path, source };
  }
  return { path: join(homedir(), ".gradle", "caches", "modules-2", "files-2.1"), source: "default" };
}

/** Both convergences in one call — what `openContext` computes once. */
export function effectiveRoots(projectRoot: string | undefined, opts: RootsOptions = {}): EffectiveRoots {
  return { m2: effectiveM2Roots(projectRoot, opts), gradle: effectiveGradleCacheRoot(projectRoot, opts) };
}
