import { describe, expect, it } from "vitest";
import { fuzzyScore, topMatches } from "../../src/core/fuzzy.js";

describe("fuzzyScore", () => {
  it("matches a camelCase-hump subsequence positively", () => {
    expect(fuzzyScore("tas", "TransactionAspectSupport")).toBeGreaterThan(0);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("tas", "StringBuilder")).toBeNull();
    expect(fuzzyScore("zzz", "StringBuilder")).toBeNull();
  });

  it("scores a case-insensitive exact match at exactly 100", () => {
    expect(fuzzyScore("demo", "Demo")).toBe(100);
    expect(fuzzyScore("Demo", "demo")).toBe(100);
  });

  it("scores a case-insensitive prefix match at least 50", () => {
    expect(fuzzyScore("dem", "DemoService")).toBeGreaterThanOrEqual(50);
    expect(fuzzyScore("tra", "TransactionInterceptor")).toBeGreaterThanOrEqual(50);
  });

  it("penalizes longer targets", () => {
    const short = fuzzyScore("run", "runA");
    const long = fuzzyScore("run", "run" + "Abcdefghij".repeat(6));
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(long!).toBeLessThan(short!);
  });

  it("rewards hump and separator boundaries over mid-word matches", () => {
    // 'S' (target start, +30) beats 'r' (mid-word, +1); 'e' after '_' beats 'n' mid-word.
    const start = fuzzyScore("S", "StringBuilder");
    const mid = fuzzyScore("r", "StringBuilder");
    expect(start).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(start!).toBeGreaterThan(mid!);
    const afterUnderscore = fuzzyScore("c", "snake_case");
    const plainMid = fuzzyScore("n", "snake_case");
    expect(afterUnderscore).not.toBeNull();
    expect(plainMid).not.toBeNull();
    expect(afterUnderscore!).toBeGreaterThan(plainMid!);
  });

  it("gives consecutive runs a higher score than scattered matches", () => {
    const tight = fuzzyScore("abc", "abcxxxxxxxxxx");
    const scattered = fuzzyScore("abc", "axbxcxxxxxxx");
    expect(tight).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(tight!).toBeGreaterThan(scattered!);
  });
});

describe("topMatches", () => {
  const ITEMS = ["TransactionAspectSupport", "TransactionInterceptor", "Map"];

  it("orders by score desc, filters nulls, and stays stable", () => {
    const out = topMatches(ITEMS, (s) => s, "tra", 10);
    expect(out.map((m) => m.item)).toEqual(["TransactionAspectSupport", "TransactionInterceptor"]);
    // equal scores keep input order (TransactionAspectSupport came first)
    const again = topMatches(
      ["TransactionInterceptor", "TransactionAspectSupport"],
      (s) => s,
      "tra",
      10,
    );
    expect(again.map((m) => m.item)).toEqual([
      "TransactionInterceptor",
      "TransactionAspectSupport",
    ]);
  });

  it("respects the limit", () => {
    expect(topMatches(ITEMS, (s) => s, "tra", 1)).toHaveLength(1);
    expect(topMatches(ITEMS, (s) => s, "tra", 1)![0]!.item).toBe("TransactionAspectSupport");
  });

  it("returns [] when nothing matches", () => {
    expect(topMatches(ITEMS, (s) => s, "zzz", 10)).toEqual([]);
  });

  it("scores with equal-length targets: prefix beats mid-target occurrence", () => {
    const out = topMatches(
      ["ExtraService", "ServiceExtra"],
      (s) => s,
      "serv",
      10,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.item).toBe("ServiceExtra");
  });
});
