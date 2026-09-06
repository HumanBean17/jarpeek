/**
 * The i18n core: locale convergence (flag > config > en), interpolation,
 * plural selection, and the raw-argv pre-scan that feeds build-time help
 * strings before commander parses anything.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalog,
  choose,
  en,
  LOCALE_VALUES,
  preScan,
  resolveLocale,
  ru,
  t,
} from "../../src/cli/i18n/index.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A tmp project root with `.jarpeek/config.json` carrying `language`. */
function configDir(language: unknown, raw = false): string {
  const root = mkdtempSync(join(tmpdir(), "jarpeek-i18n-"));
  dirs.push(root);
  mkdirSync(join(root, ".jarpeek"), { recursive: true });
  writeFileSync(
    join(root, ".jarpeek", "config.json"),
    raw ? String(language) : JSON.stringify({ language }),
  );
  return root;
}

describe("resolveLocale", () => {
  it("the flag beats the config", () => {
    expect(resolveLocale({ flag: "ru", projectRoot: configDir("en") })).toBe("ru");
  });

  it("the config beats the default", () => {
    expect(resolveLocale({ projectRoot: configDir("ru") })).toBe("ru");
  });

  it("no flag and no config means en", () => {
    const root = mkdtempSync(join(tmpdir(), "jarpeek-i18n-"));
    dirs.push(root);
    expect(resolveLocale({ projectRoot: root })).toBe("en");
  });

  it("corrupt or invalid config falls through to en", () => {
    expect(resolveLocale({ projectRoot: configDir("{not json", true) })).toBe("en");
    expect(resolveLocale({ projectRoot: configDir("de") })).toBe("en");
    expect(resolveLocale({ projectRoot: configDir(3) })).toBe("en");
  });

  it("an invalid flag is treated as absent, so config answers", () => {
    expect(resolveLocale({ flag: "xx", projectRoot: configDir("ru") })).toBe("ru");
  });
});

describe("t", () => {
  it("substitutes provided params", () => {
    expect(t("{n} artifacts in {ms}ms", { n: 3, ms: 12 })).toBe("3 artifacts in 12ms");
  });

  it("returns the template untouched without params", () => {
    expect(t("plain")).toBe("plain");
  });

  it("leaves tokens without a param literal", () => {
    expect(t("{x}")).toBe("{x}");
  });
});

describe("choose", () => {
  const forms = { one: "one", few: "few", many: "many", other: "other" };

  it("russian plural categories", () => {
    const cases: Array<[number, string]> = [
      [1, "one"],
      [2, "few"],
      [5, "many"],
      [11, "many"],
      [21, "one"],
      [22, "few"],
      [25, "many"],
    ];
    for (const [n, expected] of cases) {
      expect(choose("ru", n, forms)).toBe(expected);
    }
  });

  it("english is one/other", () => {
    expect(choose("en", 1, forms)).toBe("one");
    expect(choose("en", 0, forms)).toBe("other");
    expect(choose("en", 2, forms)).toBe("other");
  });

  it("a missing category falls back to other", () => {
    expect(choose("ru", 2, { one: "one", many: "many", other: "other" })).toBe("other");
  });
});

describe("preScan", () => {
  it("finds --lang in every position form", () => {
    expect(preScan(["--lang", "ru"]).lang).toBe("ru");
    expect(preScan(["--lang=ru"]).lang).toBe("ru");
    expect(preScan(["find-class", "X", "--lang", "ru"]).lang).toBe("ru");
  });

  it("collects lang and project together, later occurrences win", () => {
    expect(preScan(["--project", "/a", "--lang", "ru"])).toEqual({ lang: "ru", project: "/a" });
    expect(preScan(["--lang", "en", "--lang", "ru"]).lang).toBe("ru");
  });

  it("stops at -- and ignores other flags", () => {
    expect(preScan(["--", "--lang", "ru"])).toEqual({});
    expect(preScan(["--limit", "5"])).toEqual({});
  });
});

describe("catalog", () => {
  it("maps each locale to its catalog and lists the locales", () => {
    expect(catalog("en")).toBe(en);
    expect(catalog("ru")).toBe(ru);
    expect(LOCALE_VALUES).toEqual(["en", "ru"]);
  });
});
