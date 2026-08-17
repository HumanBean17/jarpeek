import { describe, expect, it } from "vitest";
import {
  matchDeclarations,
  parseSelector,
  SelectorError,
  splitSelectorList,
  type Selector,
} from "../../src/core/selector.js";
import type { Declaration } from "../../src/core/types.js";

/** Minimal method-shaped Declaration fixture; `extra` overrides defaults. */
function member(selector: string, signature: string, extra: Partial<Declaration> = {}): Declaration {
  return {
    fqn: "com.example.Demo",
    file: "com/example/Demo.java",
    selector,
    kind: "method",
    visibility: "public",
    static: false,
    deprecated: false,
    signature,
    ...extra,
  };
}

/**
 * Fixed record set spanning the matching rules: three `run` overloads, a
 * classfile-style FQN-written signature, a generic parameter whose commas
 * must not count, an extension next to a plain member of the same name, and
 * a field to prove bare-name matching is kind-agnostic.
 */
const RECORDS: Declaration[] = [
  member("run", "public void run()"),
  member("run", "public void run(String)"),
  member("run", "public void run(String,int)"),
  member("runAll", "public void runAll(java.lang.String,int)"),
  member("apply", "public void apply(Map<String,String>)"),
  member("bar", "public void bar()"),
  member("bar", "fun Foo.bar(String)", { file: "Ext.kt", receiverType: "Foo" }),
  member("NAME", "public static final String NAME", { kind: "field", static: true }),
];

/** Parse + match in one step, the way read_member composes them. */
function matched(raw: string): Declaration[] {
  return matchDeclarations(RECORDS, parseSelector(raw));
}

describe("parseSelector grammar", () => {
  it.each<[string, Selector]>([
    ["#run", { name: "run", params: null }],
    ["#run()", { name: "run", params: [] }],
    ["#run(String,int)", { name: "run", params: ["String", "int"] }],
    ["#run(String, int)", { name: "run", params: ["String", "int"] }],
    ["#run(*)", { name: "run", params: ["*"] }],
    ["#run(Map<String,String>,int)", { name: "run", params: ["Map<String,String>", "int"] }],
    ["#Foo.bar", { name: "bar", receiver: "Foo", params: null }],
    ["#Foo.bar(String)", { name: "bar", receiver: "Foo", params: ["String"] }],
  ])("parses %s", (raw, expected) => {
    expect(parseSelector(raw)).toEqual(expected);
  });

  it.each([
    ["run", "no leading #"],
    ["#", "empty name"],
    ["#run(String", "unterminated parens"],
    ["#run(String,)", "trailing comma"],
    ["#run(String;)", "character outside the allowed param set"],
    ["#.bar(String)", "empty receiver"],
  ])("rejects %s (%s)", (raw) => {
    expect(() => parseSelector(raw)).toThrow(SelectorError);
    expect(() => parseSelector(raw)).toThrow(/Usage: #/);
  });

  it("SelectorError is an Error subclass carrying a usage message", () => {
    let thrown: unknown;
    try {
      parseSelector("run");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SelectorError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Usage: #");
  });
});

describe("matchDeclarations", () => {
  it("bare #name returns every overload, never a silent pick", () => {
    expect(matched("#run").map((r) => r.signature)).toEqual([
      "public void run()",
      "public void run(String)",
      "public void run(String,int)",
    ]);
  });

  it("#run() returns only the zero-param overload", () => {
    expect(matched("#run()").map((r) => r.signature)).toEqual(["public void run()"]);
  });

  it("#run(String) returns the 1-param overload but not run(String,int)", () => {
    expect(matched("#run(String)").map((r) => r.signature)).toEqual(["public void run(String)"]);
  });

  it("#run(java.lang.String) matches the simply-written run(String)", () => {
    expect(matched("#run(java.lang.String)").map((r) => r.signature)).toEqual([
      "public void run(String)",
    ]);
  });

  it("#runAll(String,int) matches the FQN-written classfile signature", () => {
    expect(matched("#runAll(String,int)").map((r) => r.signature)).toEqual([
      "public void runAll(java.lang.String,int)",
    ]);
  });

  it("#runAll(java.lang.String,int) matches by normalized equality", () => {
    expect(matched("#runAll(java.lang.String,int)")).toHaveLength(1);
  });

  it("commas nested in generics neither split nor count as extra params", () => {
    expect(matched("#apply(Map<String,String>)")).toHaveLength(1);
    expect(matched("#apply(Map<String,String>,int)")).toEqual([]);
  });

  it("#run(*) is the wildcard: identical to the bare form", () => {
    expect(matched("#run(*)")).toHaveLength(3);
  });

  it("#Foo.bar returns only the Foo extension; bare #bar returns both", () => {
    expect(matched("#Foo.bar").map((r) => r.receiverType)).toEqual(["Foo"]);
    expect(matched("#bar")).toHaveLength(2);
    expect(matched("#Baz.bar")).toEqual([]);
  });

  it("a bare name also matches fields by name", () => {
    expect(matched("#NAME").map((r) => r.kind)).toEqual(["field"]);
  });

  it("#missing yields an empty result; the miss is the caller's to handle", () => {
    expect(matched("#missing")).toEqual([]);
  });
});

describe("matchDeclarations written-type normalization", () => {
  // Renderings below are the exact strings the producers emit, confirmed
  // against the lexers: `fun f(String?)`, `fun g(vararg Int)`, receiver
  // `Foo?`, Java `<T> void m(T...)`. Selectors stay strict — `?` is illegal
  // — so matching must normalize the WRITTEN side instead.
  const KT_RECORDS: Declaration[] = [
    member("f", "fun f(String?)"),
    member("g", "fun g(vararg Int)"),
    member("h", "fun h(noinline T.() -> Unit)"),
    member("m", "<T> void m(T...)"),
    member("n", "void n(String...)"),
    member("ext", "fun Foo?.ext(String?)", { receiverType: "Foo?" }),
    member("deep", "fun deep(String??)"),
  ];

  const ktMatched = (raw: string): Declaration[] =>
    matchDeclarations(KT_RECORDS, parseSelector(raw));

  it.each<[string, string]>([
    ["#f(String)", "fun f(String?)"],
    ["#g(Int)", "fun g(vararg Int)"],
    ["#m(T)", "<T> void m(T...)"],
    ["#n(String)", "void n(String...)"],
    ["#deep(String)", "fun deep(String??)"],
  ])("%s matches the meaning-modified written form %s", (raw, sig) => {
    expect(ktMatched(raw).map((r) => r.signature)).toEqual([sig]);
  });

  it("#Foo.ext matches a nullable Foo? receiver", () => {
    expect(ktMatched("#Foo.ext").map((r) => r.receiverType)).toEqual(["Foo?"]);
  });

  it("modifiers and nullability never fabricate a type that was not written", () => {
    // `#h(Unit)` — after stripping `noinline`, the written type is the
    // function type `T.()->Unit`, not `Unit`; no false positive.
    expect(ktMatched("#h(Unit)")).toEqual([]);
  });

  it("selectors stay strict: #f(String?) is a SelectorError, not a match", () => {
    expect(() => parseSelector("#f(String?)")).toThrow(SelectorError);
  });
});

describe("splitSelectorList", () => {
  it.each<[string, string[]]>([
    ["#a,#b,#c", ["#a", "#b", "#c"]],
    ["#a(X,Y),#b", ["#a(X,Y)", "#b"]],
    ["#a,#b,", ["#a", "#b"]],
    ["#run(String,#x),#b", ["#run(String,#x)", "#b"]],
    [" #a , #b ", ["#a", "#b"]],
    ["#a(Map<String,String>),#b", ["#a(Map<String,String>)", "#b"]],
  ])("splits %s", (raw, expected) => {
    expect(splitSelectorList(raw)).toEqual(expected);
  });
});
