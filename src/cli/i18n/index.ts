/**
 * The CLI's localization core. Localizes human-mode output only — `--json`,
 * the MCP server, and the prime cheatsheet stay English by contract, as do
 * strings produced by core/resolver (they are diagnostics shared with the
 * `--json` surface). Locale convergence follows the primeMode pattern:
 * the `--lang` flag, else `.jarpeek/config.json`'s `language` field, else
 * English; absent, corrupt, or invalid values fall through to the next
 * layer, and an invalid flag value is left for commander's `choices`
 * rejection (it is treated as absent here).
 *
 * The argv pre-scan exists because commander builds the program —
 * descriptions, option help, help blocks — before parsing: `preScan` reads
 * the raw argv so those build-time strings can already speak the locale
 * the invocation will land on. Runtime actions re-resolve through the
 * parsed options instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en, type Catalog } from "./en.js";
import { ru } from "./ru.js";

export { en, ru };
export type { Catalog };

/** The locales the CLI ships a catalog for. */
export type Locale = "en" | "ru";

/** The locale ids in stable order — commander `choices` and tests read this. */
export const LOCALE_VALUES: readonly Locale[] = ["en", "ru"];

/** Where the `language` field lives, relative to the project root. */
const CONFIG_PATH = join(".jarpeek", "config.json");

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ru";
}

/** The catalog a locale renders through. */
export function catalog(locale: Locale): Catalog {
  return locale === "en" ? en : ru;
}

/**
 * Fill a catalog template's `{name}` tokens. Only provided params are
 * substituted: unreferenced params are ignored, and a token without a
 * param stays literal (a visible bug, not a swallowed one).
 */
export function t(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    name in params ? String(params[name]) : token,
  );
}

/**
 * Pick a plural form for `count` in `locale` via `Intl.PluralRules`
 * (Russian needs one/few/many; English one/other). A category the forms
 * object omits falls back to `other`.
 */
export function choose(locale: Locale, count: number, forms: Record<string, string>): string {
  const category = new Intl.PluralRules(locale).select(count);
  return forms[category] ?? forms.other;
}

/**
 * Converge the effective locale: a valid `--lang` flag value, else the
 * config's `language` field, else English. An invalid flag value counts
 * as absent (commander reports it as a usage error on its own).
 */
export function resolveLocale(input: { flag?: string; projectRoot: string }): Locale {
  if (isLocale(input.flag)) return input.flag;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(input.projectRoot, CONFIG_PATH), "utf8"));
  } catch {
    return "en";
  }
  const language =
    typeof doc === "object" && doc !== null ? (doc as { language?: unknown }).language : undefined;
  return isLocale(language) ? language : "en";
}

/**
 * Read `--lang` / `--project` (space and `=` forms) out of the raw argv,
 * left to right, stopping at a bare `--`. Later occurrences win. This is
 * only for strings composed while the commander program is being built;
 * everything runtime resolves through parsed options.
 */
export function preScan(argv: string[]): { lang?: string; project?: string } {
  const out: { lang?: string; project?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (arg === "--lang" || arg === "--project") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out[arg === "--lang" ? "lang" : "project"] = value;
        i++;
      }
    } else if (arg.startsWith("--lang=")) {
      out.lang = arg.slice("--lang=".length);
    } else if (arg.startsWith("--project=")) {
      out.project = arg.slice("--project=".length);
    }
  }
  return out;
}
