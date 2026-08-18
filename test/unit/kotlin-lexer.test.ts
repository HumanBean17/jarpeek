import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseKotlinSource,
  type ParsedClass,
  type SourceFileDeclarations,
} from "../../src/parse/kotlin-lexer.js";
import type { Declaration } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SRC = join(FIXTURES, "src", "kotlin");

function readFixture(name: string): string {
  return readFileSync(join(SRC, name), "utf8");
}

function classByFqn(parsed: SourceFileDeclarations, fqn: string): ParsedClass {
  const cls = parsed.classes.find((c) => c.fqn === fqn);
  expect(cls, `class ${fqn} should be parsed`).toBeDefined();
  return cls!;
}

function member(cls: ParsedClass, selector: string, signaturePart?: string): Declaration {
  const candidates = cls.members.filter((m) => m.selector === selector);
  const found =
    signaturePart === undefined
      ? candidates[0]
      : candidates.find((m) => m.signature.includes(signaturePart));
  expect(
    found,
    `member ${cls.fqn}.${selector} (${signaturePart ?? "any"}) should exist; got: ` +
      cls.members.map((m) => m.signature).join(" | "),
  ).toBeDefined();
  return found!;
}

describe("Facade.kt: file facade from top-level declarations", () => {
  const parsed = parseKotlinSource(readFixture("Facade.kt"), "Facade.kt");

  it("creates the FacadeKt facade class holding the top-level members", () => {
    expect(parsed.pkg).toBeNull();
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.classes.map((c) => c.fqn)).toEqual(["FacadeKt"]);
    const facade = classByFqn(parsed, "FacadeKt");
    expect(facade.kind).toBe("class");
    expect(facade.visibility).toBe("public");
    expect(facade.signature).toBe("class FacadeKt");
  });

  it("records alpha as a public static method with KDoc and threshold as a property", () => {
    const facade = classByFqn(parsed, "FacadeKt");
    const alpha = member(facade, "alpha");
    expect(alpha.kind).toBe("method");
    expect(alpha.visibility).toBe("public");
    expect(alpha.static).toBe(true);
    expect(alpha.fqn).toBe("FacadeKt");
    expect(alpha.file).toBe("Facade.kt");
    expect(alpha.signature).toBe("fun alpha()");
    expect(alpha.javadocStart).toBe(4);
    expect(alpha.lineStart).toBe(5);
    const threshold = member(facade, "threshold");
    expect(threshold.kind).toBe("property");
    expect(threshold.signature).toBe("val threshold: Int");
    expect(threshold.lineEnd).toBe(9);
  });

  it("keeps the default value with comma and paren out of the signature", () => {
    const facade = classByFqn(parsed, "FacadeKt");
    const greet = member(facade, "greet");
    expect(greet.signature).toBe("fun greet(String)");
    expect(greet.signature.match(/\(/g)).toHaveLength(1);
    expect(greet.signature.includes(",")).toBe(false);
  });

  it("parses backtick identifiers as plain member names", () => {
    const facade = classByFqn(parsed, "FacadeKt");
    const whenFun = member(facade, "when");
    expect(whenFun.kind).toBe("method");
    expect(whenFun.selector).toBe("when");
  });

  it("is not confused by }, fun, or templates inside a raw string", () => {
    const facade = classByFqn(parsed, "FacadeKt");
    const banner = member(facade, "banner");
    expect(banner.signature).toBe("fun banner(): String");
    expect(banner.lineStart).toBe(19);
    expect(banner.lineEnd).toBe(22); // the closing """.trimIndent() line
    const after = member(facade, "afterBanner");
    expect(after.kind).toBe("property");
    expect(after.lineStart).toBe(24);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("Sample.kt: classes, modifiers, and members", () => {
  const parsed = parseKotlinSource(readFixture("Sample.kt"), "com/example/Sample.kt");

  it("reads the package and produces no facade for a classes-only file", () => {
    expect(parsed.pkg).toBe("com.example");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.classes.some((c) => c.fqn.endsWith("Kt"))).toBe(false);
    expect(parsed.classes.map((c) => c.fqn)).toEqual([
      "com.example.User",
      "com.example.Repo",
      "com.example.Impl",
      "com.example.Impl.Companion",
      "com.example.Color",
      "com.example.Singleton",
      "com.example.Account",
    ]);
  });

  it("parses the data class with constructor properties as val members", () => {
    const user = classByFqn(parsed, "com.example.User");
    expect(user.kind).toBe("class");
    expect(user.visibility).toBe("public");
    expect(user.signature).toBe("data class User(String,Int)");
    const name = member(user, "name");
    expect(name.kind).toBe("property");
    expect(name.signature).toBe("val name: String");
    expect(name.lineEnd).toBe(5);
    expect(member(user, "age").signature).toBe("val age: Int");
    expect(member(user, "age").kind).toBe("property");
    expect(user.members.map((m) => m.selector).sort()).toEqual(["age", "name"]);
  });

  it("parses the suspend interface method with nullable return", () => {
    const repo = classByFqn(parsed, "com.example.Repo");
    expect(repo.kind).toBe("interface");
    const load = member(repo, "load");
    expect(load.kind).toBe("method");
    expect(load.signature).toBe("suspend fun load(Long): User?");
    expect(load.modifiers).toContain("suspend");
    expect(load.receiverType).toBeUndefined();
  });

  it("nests the companion object as a Companion ParsedClass with static members", () => {
    const impl = classByFqn(parsed, "com.example.Impl");
    expect(impl.kind).toBe("class");
    expect(impl.members.some((m) => m.selector === "Companion" && m.kind === "object")).toBe(true);
    const comp = classByFqn(parsed, "com.example.Impl.Companion");
    expect(comp.kind).toBe("object");
    expect(comp.static).toBe(true);
    expect(member(impl, "Companion").modifiers).toContain("companion");
    const def = member(comp, "default");
    expect(def.kind).toBe("property");
    expect(def.static).toBe(true);
  });

  it("parses enum entries, the object singleton, and their members", () => {
    const color = classByFqn(parsed, "com.example.Color");
    expect(color.kind).toBe("enum");
    const entries = color.members.filter((m) => m.kind === "enum-constant");
    expect(entries.map((e) => e.selector)).toEqual(["RED", "GREEN", "BLUE"]);
    expect(entries[0]!.lineStart).toBe(20);
    const singleton = classByFqn(parsed, "com.example.Singleton");
    expect(singleton.kind).toBe("object");
    const ready = member(singleton, "ready");
    expect(ready.kind).toBe("property");
    expect(ready.static).toBe(true);
    expect(member(singleton, "reset").signature).toBe("fun reset()");
  });

  it("records init and secondary constructors but not custom accessors", () => {
    const account = classByFqn(parsed, "com.example.Account");
    const ctors = account.members.filter((m) => m.kind === "constructor");
    expect(ctors).toHaveLength(2);
    expect(ctors.every((c) => c.selector === "Account")).toBe(true);
    expect(ctors.some((c) => c.signature === "constructor(Long)")).toBe(true);
    expect(ctors.some((c) => c.lineStart === 35)).toBe(true); // init block
    const locked = account.members.filter((m) => m.selector === "locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]!.kind).toBe("property");
    expect(locked[0]!.lineEnd).toBe(33); // includes the get() = field accessor
    expect(account.members.some((m) => m.selector === "get")).toBe(false);
    expect(member(account, "balance").signature).toBe("var balance: Long");
    expect(member(account, "deposit").signature).toBe("fun deposit(Long): Long");
  });
});

describe("Ext.kt: extensions and reified generics", () => {
  const parsed = parseKotlinSource(readFixture("Ext.kt"), "Ext.kt");
  const facade = classByFqn(parsed, "ExtKt");

  it("exposes extensions as facade members with receiverType", () => {
    expect(parsed.diagnostics).toEqual([]);
    const shout = member(facade, "shout");
    expect(shout.kind).toBe("method");
    expect(shout.receiverType).toBe("String");
    expect(shout.signature).toBe("fun String.shout(): String");
  });

  it("handles inline reified generics and a generic receiver", () => {
    const first = member(facade, "firstOfType");
    expect(first.modifiers).toContain("inline");
    expect(first.modifiers).toContain("reified");
    expect(first.receiverType).toBe("List<T>");
    expect(first.signature).toBe("inline fun <reified T> List<T>.firstOfType(): T?");
  });

  it("supports extension properties with accessors", () => {
    const sum = member(facade, "sumOrZero");
    expect(sum.kind).toBe("property");
    expect(sum.receiverType).toBe("List<Int>");
    expect(sum.signature).toBe("val List<Int>.sumOrZero: Int");
  });
});

describe("Expect.kt: expect/actual platform fields", () => {
  const parsed = parseKotlinSource(readFixture("Expect.kt"), "Expect.kt");
  const facade = classByFqn(parsed, "ExpectKt");

  it("tags expect and actual functions", () => {
    expect(parsed.diagnostics).toEqual([]);
    const overloads = facade.members.filter((m) => m.selector === "platformName");
    expect(overloads).toHaveLength(2);
    const expected = overloads.find((m) => m.platform === "expect");
    const actual = overloads.find((m) => m.platform === "actual");
    expect(expected?.signature).toBe("expect fun platformName(): String");
    expect(actual?.signature).toBe("actual fun platformName(): String");
    expect(actual?.lineEnd).toBe(6); // = "jvm" initializer line
  });

  it("tags expect and actual properties", () => {
    const sizes = facade.members.filter((m) => m.selector === "cacheSize");
    expect(sizes).toHaveLength(2);
    expect(sizes.some((m) => m.platform === "expect" && m.kind === "property")).toBe(true);
    expect(sizes.some((m) => m.platform === "actual" && m.kind === "property")).toBe(true);
  });
});

describe("facade naming (synthetic)", () => {
  it("prefixes the package and sanitizes the file base name", () => {
    const parsed = parseKotlinSource("package p\n\nfun a() {}\n", "Files.kt");
    expect(parsed.classes.map((c) => c.fqn)).toEqual(["p.FilesKt"]);
    const weird = parseKotlinSource("fun a() {}\n", "dir/weird-name 2.kt");
    expect(weird.classes.map((c) => c.fqn)).toEqual(["weird_name_2Kt"]);
  });
});

describe("advanced syntax (synthetic)", () => {
  const source = [
    "package p",
    "",
    "abstract class Base {",
    '    open fun template(): String = "base"',
    "}",
    "",
    "class Store<out T> {",
    "    fun <in U : Any> swap(u: U): Unit {}",
    "}",
    "",
    "class Derived(x: Int) : Base(), Comparable<Derived> {",
    "    private val pool by lazy { listOf(x) }",
    '    var tag: String = "?"',
    "        set(value) { field = value }",
    '    override fun template(): String = "done"',
    '    fun apply(vararg notes: String, block: (Int) -> Unit): suspend () -> String = { "s" }',
    "    suspend fun fetch(handler: suspend (Long) -> Unit): Map<String, Int> = emptyMap()",
    "}",
  ].join("\n");
  const parsed = parseKotlinSource(source, "p/Derived.kt");
  const derived = classByFqn(parsed, "p.Derived");

  it("parses function types in params and returns with normalized spacing", () => {
    expect(parsed.diagnostics).toEqual([]);
    expect(member(derived, "apply").signature).toBe(
      "fun apply(vararg String, (Int) -> Unit): suspend () -> String",
    );
    expect(member(derived, "fetch").signature).toBe(
      "suspend fun fetch(suspend (Long) -> Unit): Map<String, Int>",
    );
  });

  it("keeps variance markers inside type parameters", () => {
    const store = classByFqn(parsed, "p.Store");
    expect(store.signature).toBe("class Store<out T>");
    expect(member(store, "swap").signature).toBe("fun <in U : Any> swap(U): Unit");
  });

  it("handles by-lazy initializers, accessors, and delegation supertypes", () => {
    const pool = member(derived, "pool");
    expect(pool.kind).toBe("property");
    expect(pool.visibility).toBe("private");
    const tag = derived.members.filter((m) => m.selector === "tag");
    expect(tag).toHaveLength(1);
    expect(tag[0]!.lineEnd).toBe(14); // the set(...) { ... } accessor line
    expect(derived.members.some((m) => m.selector === "set")).toBe(false);
  });
});

describe("recovery regressions (synthetic)", () => {
  it("parses fun interface as a kind keyword without eating the rest of the file", () => {
    const source = [
      "package p",
      "",
      "fun interface Printer {",
      "    fun print(s: String)",
      "}",
      "",
      "class After {",
      '    val tag: String = "a"',
      "}",
    ].join("\n");
    const parsed = parseKotlinSource(source, "p/Printer.kt");
    expect(parsed.diagnostics).toEqual([]);
    const printer = classByFqn(parsed, "p.Printer");
    expect(printer.kind).toBe("interface");
    expect(printer.signature).toBe("fun interface Printer");
    expect(printer.members.some((m) => m.selector === "print")).toBe(true);
    const after = classByFqn(parsed, "p.After");
    expect(member(after, "tag").kind).toBe("property");
  });

  it("parses explicit primary constructors with modifiers and annotations", () => {
    const source = [
      "package p",
      "",
      "class Solo private constructor(x: Int) {",
      "    fun ping(): Int = x",
      "}",
      "",
      "class Tagged @Inject constructor() {",
      "    val tag: Int = 1",
      "}",
      "",
      "val afterSolo: Int = 2",
    ].join("\n");
    const parsed = parseKotlinSource(source, "p/Solo.kt");
    expect(parsed.diagnostics).toEqual([]);
    const solo = classByFqn(parsed, "p.Solo");
    expect(solo.signature).toBe("class Solo(Int)");
    expect(member(solo, "ping")).toBeDefined();
    const tagged = classByFqn(parsed, "p.Tagged");
    expect(tagged.signature).toBe("class Tagged()");
    expect(member(tagged, "tag")).toBeDefined();
    const facade = classByFqn(parsed, "p.SoloKt");
    expect(member(facade, "afterSolo").kind).toBe("property");
  });

  it("folds a modifier accessor into the property and keeps later members", () => {
    const source = [
      "package p",
      "",
      "class Counter {",
      "    var count: Int = 0",
      "        private set",
      "    fun bump() {",
      "        count += 1",
      "    }",
      '    val name: String = "c"',
      "}",
    ].join("\n");
    const parsed = parseKotlinSource(source, "p/Counter.kt");
    expect(parsed.diagnostics).toEqual([]);
    const counter = classByFqn(parsed, "p.Counter");
    const count = member(counter, "count");
    expect(count.lineEnd).toBe(5); // the `private set` line
    expect(member(counter, "bump")).toBeDefined();
    expect(member(counter, "name")).toBeDefined();
    expect(counter.members.filter((m) => m.selector === "set")).toHaveLength(0);
  });
});

describe("graceful degradation", () => {
  it("never throws on unterminated, malformed, or empty input", () => {
    const junk = [
      "class { \\unterminated ",
      "%%%((",
      "",
      "}}}{{{",
      'fun f( { ; "unclosed',
      "fun g() = \"\"\"unterminated raw",
      "val x = ${ ",
      "object {",
    ];
    for (const input of junk) {
      let parsed: SourceFileDeclarations | null = null;
      expect(() => {
        parsed = parseKotlinSource(input, "junk.kt");
      }, `input ${JSON.stringify(input)} must not throw`).not.toThrow();
      expect(parsed).not.toBeNull();
    }
  });

  it("reports diagnostics for garbage instead of classes or crashes", () => {
    const parsed = parseKotlinSource("%%%((", "garbage.kt");
    expect(parsed.classes).toEqual([]);
    expect(parsed.diagnostics.length).toBeGreaterThanOrEqual(1);
  });

  it("never throws on pseudo-random bytes", () => {
    // deterministic LCG so failures reproduce; latin1 keeps every byte round-tripping
    let state = 0x2f6e2b1;
    const bytes = Buffer.alloc(4096);
    for (let i = 0; i < bytes.length; i++) {
      state = (state * 1103515245 + 12345) % 0x80000000;
      bytes[i] = state & 0xff;
    }
    expect(() => parseKotlinSource(bytes.toString("latin1"), "random.kt")).not.toThrow();
  });
});

describe("import capture and KDoc text (synthetic)", () => {
  const source = [
    "package p",
    "import a.b.C",
    "import a.b.C as D",
    "import x.y.*",
    "",
    "/** Keeps state. */",
    "class Keeper {",
    "    /** Bumps the counter. */",
    "    fun bump() {}",
    "",
    "    val plain: Int = 0",
    "}",
  ].join("\n");
  const parsed = parseKotlinSource(source, "p/Keeper.kt");

  it("captures imports verbatim, alias included, without semicolons", () => {
    expect(parsed.imports).toEqual(["import a.b.C", "import a.b.C as D", "import x.y.*"]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("carries the raw KDoc block on class and member records", () => {
    const keeper = classByFqn(parsed, "p.Keeper");
    expect(keeper.javadoc).toBe("/** Keeps state. */");
    expect(member(keeper, "bump").javadoc).toBe("/** Bumps the counter. */");
    expect(member(keeper, "plain").javadoc).toBeUndefined();
  });

  it("yields no imports for a file without import statements", () => {
    expect(parseKotlinSource("class Solo\n", "Solo.kt").imports).toEqual([]);
  });

  it("captures imports from CRLF sources and an import at EOF without a newline", () => {
    const crlf = parseKotlinSource("package p\r\nimport a.b.C\r\nclass K {}", "K.kt");
    expect(crlf.imports).toEqual(["import a.b.C"]);
    expect(crlf.diagnostics).toEqual([]);
    const eof = parseKotlinSource("package p\nimport a.b.C as D", "E.kt");
    expect(eof.imports).toEqual(["import a.b.C as D"]);
    expect(eof.diagnostics).toEqual([]);
  });
});

describe("interface-nested declarations are implicitly static (synthetic)", () => {
  const source = [
    "package p",
    "",
    "interface Contract {",
    "    class Impl : Contract",
    "    fun go()",
    "    object Registry",
    "}",
    "",
    "class Container {",
    "    class Nested",
    "}",
  ].join("\n");
  const parsed = parseKotlinSource(source, "p/Contract.kt");
  const contract = classByFqn(parsed, "p.Contract");

  it("class and object nested in an interface report static (JVM ACC_STATIC parity)", () => {
    expect(parsed.diagnostics).toEqual([]);
    expect(member(contract, "Impl").static).toBe(true);
    expect(member(contract, "Registry").static).toBe(true);
  });

  it("a class nested in a class stays non-static", () => {
    const container = classByFqn(parsed, "p.Container");
    expect(member(container, "Nested").static).toBe(false);
  });
});

describe("broken literals and lambda defaults (graceful degradation)", () => {
  it("an unterminated plain string costs one declaration, not the rest of the file", () => {
    const source = [
      "package p",
      "",
      "class Before {",
      "  val ok = 1",
      "}",
      "val broken = \"oops",
      "class After {",
      "  fun later() = 2",
      "}",
      "",
    ].join("\n");
    const parsed = parseKotlinSource(source, "Broken.kt");

    const after = classByFqn(parsed, "p.After");
    expect(member(after, "later").kind).toBe("method");
    expect(parsed.classes.map((c) => c.fqn)).toContain("p.Before");
    expect(parsed.classes.map((c) => c.fqn)).toContain("p.After");
  });

  it("raw strings still span lines, including a multi-line template expression", () => {
    const source = [
      "package p",
      "",
      "class Raw {",
      "  val text = \"\"\"",
      "    line one",
      "    ${list.joinToString(",
      "      separator = \",\",",
      "    ) { it.name }",
      "  \"\"\".trim()",
      "  fun keep() = 1",
      "}",
      "",
    ].join("\n");
    const parsed = parseKotlinSource(source, "Raw.kt");
    const raw = classByFqn(parsed, "p.Raw");
    expect(member(raw, "keep").kind).toBe("method");
  });

  it("a comma inside a lambda default value does not split the parameter", () => {
    const source = [
      "package p",
      "",
      "class Ctor(val cb: (Int, Int) -> Unit = { a, b -> }, val mode: Int)",
      "",
      "fun f(g: (Int, Int) -> Int = { a, b: Int -> a + b }) = g(1, 2)",
      "",
    ].join("\n");
    const parsed = parseKotlinSource(source, "Defaults.kt");

    // the primary constructor keeps exactly its two parameters
    const ctor = classByFqn(parsed, "p.Ctor");
    expect(ctor.signature).toBe("class Ctor((Int, Int) -> Unit,Int)");
    expect(ctor.members.filter((m) => m.kind === "property")).toHaveLength(2);

    // the function's signature carries one parameter, not a split fragment
    const facade = classByFqn(parsed, "p.DefaultsKt");
    expect(member(facade, "f").signature).toBe("fun f((Int, Int) -> Int)");
  });
});
