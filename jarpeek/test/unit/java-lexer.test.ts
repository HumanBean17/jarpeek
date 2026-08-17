import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJavaSource,
  type ParsedClass,
  type SourceFileDeclarations,
} from "../../src/parse/java-lexer.js";
import type { Declaration } from "../../src/core/types.js";
import { listZipEntries, readTextEntry } from "../../src/parse/zip.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SRC = join(FIXTURES, "src", "java", "com", "example");
const SOURCES_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0-sources.jar");

function readFixture(name: string): string {
  return readFileSync(join(SRC, name), "utf8");
}

function fixtureLines(name: string): string[] {
  return readFixture(name).split(/\r?\n/);
}

/** 1-based line of the first fixture line containing `needle`. */
function findLine(lines: string[], needle: string): number {
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`fixture line not found: ${needle}`);
  return idx + 1;
}

/**
 * 1-based line of the `/**` opening the javadoc directly above `declLine`.
 * Walks up over javadoc continuation lines and annotation lines (they sit
 * between the javadoc and the declaration), stopping at the first other
 * content — mirroring how the lexer must attach javadoc through annotations.
 */
function javadocAbove(lines: string[], declLine: number): number {
  for (let i = declLine - 2; i >= 0; i--) {
    const t = lines[i]!.trimStart();
    if (t.startsWith("/**")) return i + 1;
    if (t.length > 0 && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("@")) {
      break;
    }
  }
  throw new Error(`no javadoc found above line ${declLine}`);
}

/**
 * 1-based line where brace depth opened on `startLine` (1-based) returns to
 * zero — the declaration's closing brace. Fixture bodies contain no braces
 * inside string literals, so raw counting is exact here.
 */
function closingBrace(lines: string[], startLine: number): number {
  let depth = 0;
  let seen = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (seen && depth === 0) return i + 1;
  }
  throw new Error(`no closing brace found from line ${startLine}`);
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

describe("Demo.java goldens", () => {
  const lines = fixtureLines("Demo.java");
  const parsed = parseJavaSource(readFixture("Demo.java"), "com/example/Demo.java");

  it("reads the package and finds the public class", () => {
    expect(parsed.pkg).toBe("com.example");
    expect(parsed.diagnostics).toEqual([]);
    const demo = classByFqn(parsed, "com.example.Demo");
    expect(demo.kind).toBe("class");
    expect(demo.visibility).toBe("public");
    expect(demo.static).toBe(false);
    expect(demo.deprecated).toBe(false);
    expect(demo.signature).toBe("public class Demo");
    expect(demo.lineStart).toBe(findLine(lines, "public class Demo {"));
    expect(demo.lineEnd).toBe(closingBrace(lines, findLine(lines, "public class Demo {")));
    expect(demo.javadocStart).toBe(javadocAbove(lines, findLine(lines, "public class Demo {")));
  });

  it("parses run(String,int) with exact signature, javadoc, and brace span", () => {
    const demo = classByFqn(parsed, "com.example.Demo");
    const sigLine = findLine(lines, "public Object run(String input, int count)");
    const run = member(demo, "run", "run(String,int)");
    expect(run.kind).toBe("method");
    expect(run.signature).toBe("public Object run(String,int)");
    expect(run.visibility).toBe("public");
    expect(run.static).toBe(false);
    expect(run.deprecated).toBe(false);
    expect(run.fqn).toBe("com.example.Demo");
    expect(run.file).toBe("com/example/Demo.java");
    expect(run.javadocStart).toBe(javadocAbove(lines, sigLine));
    expect(run.lineStart).toBe(sigLine);
    expect(run.lineEnd).toBe(closingBrace(lines, sigLine));
    expect(run.receiverType).toBeUndefined(); // Java has no extension receivers
  });

  it("keeps the package-private zero-arg overload beside the public one", () => {
    const demo = classByFqn(parsed, "com.example.Demo");
    const overloads = demo.members.filter((m) => m.selector === "run");
    expect(overloads).toHaveLength(2);
    const bare = member(demo, "run", "run()");
    expect(bare.signature).toBe("void run()");
    expect(bare.visibility).toBe("package");
    expect(bare.kind).toBe("method");
  });

  it("parses the field, the deprecated method, and the nested class", () => {
    const demo = classByFqn(parsed, "com.example.Demo");
    const name = member(demo, "NAME");
    expect(name.kind).toBe("field");
    expect(name.static).toBe(true);
    expect(name.visibility).toBe("private");
    expect(name.deprecated).toBe(false);
    expect(name.signature).toBe("private static final String NAME");
    expect(name.lineStart).toBe(findLine(lines, "private static final String NAME"));
    expect(name.lineEnd).toBe(findLine(lines, "private static final String NAME"));

    const oldLine = findLine(lines, "void old()");
    const old = member(demo, "old");
    expect(old.deprecated).toBe(true); // @Deprecated annotation AND javadoc @deprecated tag
    expect(old.javadocStart).toBe(javadocAbove(lines, oldLine));
    expect(old.signature).toBe("void old()");
    expect(old.visibility).toBe("package");

    const workerLine = findLine(lines, "public static class Worker");
    const worker = classByFqn(parsed, "com.example.Demo.Worker");
    expect(worker.kind).toBe("class");
    expect(worker.visibility).toBe("public");
    expect(worker.static).toBe(true);
    expect(worker.signature).toBe("public static class Worker");
    expect(worker.lineStart).toBe(workerLine);
    expect(worker.lineEnd).toBe(closingBrace(lines, workerLine));
    expect(worker.javadocStart).toBe(javadocAbove(lines, workerLine));
    const work = member(worker, "work");
    expect(work.signature).toBe("protected int work()");
    expect(work.visibility).toBe("protected");
    // the nested class is also a member record of its enclosing class
    const workerMember = member(demo, "Worker");
    expect(workerMember.kind).toBe("class");
    expect(workerMember.fqn).toBe("com.example.Demo");
  });
});

describe("Outer.java: nesting without anonymous/lambda leakage", () => {
  const lines = fixtureLines("Outer.java");
  const parsed = parseJavaSource(readFixture("Outer.java"), "com/example/Outer.java");

  it("produces both fqns with the nested class nested by name", () => {
    expect(parsed.classes.map((c) => c.fqn).sort()).toEqual([
      "com.example.Outer",
      "com.example.Outer.Inner",
    ]);
    const outer = classByFqn(parsed, "com.example.Outer");
    const dispatchLine = findLine(lines, "public void dispatch(String task)");
    const dispatch = member(outer, "dispatch");
    expect(dispatch.signature).toBe("public void dispatch(String)");
    expect(dispatch.lineStart).toBe(dispatchLine);
    expect(dispatch.lineEnd).toBe(closingBrace(lines, dispatchLine));
    expect(dispatch.javadocStart).toBe(javadocAbove(lines, dispatchLine));
  });

  it("counts exactly the real methods: anonymous run() and lambda bodies excluded", () => {
    const outer = classByFqn(parsed, "com.example.Outer");
    const methods = outer.members.filter((m) => m.kind === "method");
    expect(methods.map((m) => m.selector)).toEqual(["dispatch"]);
    expect(outer.members.some((m) => m.selector === "run")).toBe(false);
    const inner = classByFqn(parsed, "com.example.Outer.Inner");
    expect(member(inner, "describe").signature).toBe("public String describe()");
    expect(inner.static).toBe(false);
  });
});

describe("Colors.java / Point.java / Res.java goldens", () => {
  it("parses enum constants as public static enum-constant members", () => {
    const parsed = parseJavaSource(readFixture("Colors.java"), "com/example/Colors.java");
    const colors = classByFqn(parsed, "com.example.Colors");
    expect(colors.kind).toBe("enum");
    expect(colors.signature).toBe("public enum Colors");
    for (const [name, line] of [
      ["RED", 5],
      ["GREEN", 6],
      ["BLUE", 7],
    ] as const) {
      const constant = member(colors, name);
      expect(constant.kind).toBe("enum-constant");
      expect(constant.visibility).toBe("public");
      expect(constant.static).toBe(true);
      expect(constant.lineStart).toBe(line);
      expect(constant.lineEnd).toBe(line);
    }
    expect(member(colors, "label").signature).toBe("public String label()");
  });

  it("parses the record and its compact constructor with header params", () => {
    const parsed = parseJavaSource(readFixture("Point.java"), "com/example/Point.java");
    const point = classByFqn(parsed, "com.example.Point");
    expect(point.kind).toBe("record");
    expect(point.signature).toBe("public record Point(int,int)");
    const ctor = member(point, "Point");
    expect(ctor.kind).toBe("constructor");
    expect(ctor.signature).toContain("Point(int,int)");
    expect(ctor.signature).toBe("public Point(int,int)");
    expect(ctor.visibility).toBe("public");
  });

  it("parses the annotation type and its defaulted member", () => {
    const parsed = parseJavaSource(readFixture("Res.java"), "com/example/Res.java");
    const res = classByFqn(parsed, "com.example.Res");
    expect(res.kind).toBe("annotation");
    expect(res.signature).toBe("public @interface Res");
    const value = member(res, "value");
    expect(value.kind).toBe("method");
    expect(value.signature).toBe("String value()");
    expect(value.visibility).toBe("package");
    expect(value.lineEnd).toBe(7); // the `;` of `default "";`
  });
});

describe("BigService.java stress", () => {
  it("parses all 100 generated methods with javadoc attached", () => {
    const parsed = parseJavaSource(readFixture("BigService.java"), "com/example/BigService.java");
    const big = classByFqn(parsed, "com.example.BigService");
    const methods = big.members.filter((m) => m.kind === "method");
    expect(methods).toHaveLength(100);
    expect(methods.map((m) => m.selector)).toContain("m0");
    expect(methods.map((m) => m.selector)).toContain("m99");
    for (const m of methods) {
      expect(m.javadocStart, `${m.selector} should carry javadoc`).toBeDefined();
      expect(m.lineStart).toBeLessThanOrEqual(m.lineEnd!);
    }
  });
});

describe("signature normalization (synthetic source)", () => {
  const source = [
    "package p;",
    "import java.util.List;",
    "public abstract class Sig<T> implements Runnable {",
    "    public static final Map<String, List<Integer>> CACHE = new HashMap<>();",
    "    public abstract void go(String[] args, int... nums);",
    "    protected static <E> List<E> of(E e) { return null; }",
    "    public Sig(int x) { }",
    "    static { int x = 1; }",
    "}",
  ].join("\n");
  const parsed = parseJavaSource(source, "p/Sig.java");
  const sig = classByFqn(parsed, "p.Sig");

  it("preserves generics, arrays, and varargs with collapsed whitespace", () => {
    expect(member(sig, "CACHE").signature).toBe("public static final Map<String,List<Integer>> CACHE");
    expect(member(sig, "go").signature).toBe("public abstract void go(String[],int...)");
    expect(member(sig, "go").lineEnd).toBe(5); // abstract method ends at its `;`
    expect(member(sig, "of").signature).toBe("protected static <E> List<E> of(E)");
    expect(member(sig, "of").modifiers).toEqual(["protected", "static"]);
  });

  it("records constructors and skips static initializer blocks", () => {
    const ctor = member(sig, "Sig");
    expect(ctor.kind).toBe("constructor");
    expect(ctor.signature).toBe("public Sig(int)");
    expect(sig.members.map((m) => m.selector)).toEqual(["CACHE", "go", "of", "Sig"]);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("C-style postfix array declarators (synthetic)", () => {
  const source = [
    "package p;",
    "public class Arrays {",
    "    int a[];",
    "    int grid[][];",
    "    public static void main(String args[]) { }",
    "    void mixed(String[] prefix, int n[]) { }",
    "}",
  ].join("\n");
  const parsed = parseJavaSource(source, "p/Arrays.java");
  const arrays = classByFqn(parsed, "p.Arrays");

  it("records the field's own terminator line with no spurious diagnostics", () => {
    expect(parsed.diagnostics).toEqual([]);
    const a = member(arrays, "a");
    expect(a.kind).toBe("field");
    expect(a.signature).toBe("int a[]");
    expect(a.lineStart).toBe(3);
    expect(a.lineEnd).toBe(3);
    expect(member(arrays, "grid").signature).toBe("int grid[][]");
    expect(member(arrays, "grid").lineEnd).toBe(4);
  });

  it("drops the leaked parameter name and keeps the array type", () => {
    expect(member(arrays, "main").signature).toBe("public static void main(String[])");
    expect(member(arrays, "mixed").signature).toBe("void mixed(String[],int[])");
  });
});

describe("modifier recording (synthetic)", () => {
  const source = [
    "package p;",
    "public class Holder {",
    "    public sealed interface Shape permits Round {}",
    "    public non-sealed class Round implements Shape {}",
    "    public interface Named {",
    '        default String name() { return "n"; }',
    "    }",
    "}",
  ].join("\n");
  const parsed = parseJavaSource(source, "p/Holder.java");
  const holder = classByFqn(parsed, "p.Holder");

  it("records sealed, non-sealed, and default in modifiers[]", () => {
    expect(parsed.diagnostics).toEqual([]);
    expect(member(holder, "Shape").modifiers).toContain("sealed");
    expect(member(holder, "Shape").signature).toBe("public sealed interface Shape");
    expect(member(holder, "Round").modifiers).toContain("non-sealed");
    expect(member(holder, "Round").signature).toBe("public non-sealed class Round");
    const named = classByFqn(parsed, "p.Holder.Named");
    expect(member(named, "name").modifiers).toContain("default");
  });
});

describe("javadoc-only deprecation (synthetic)", () => {
  it("sets deprecated from the @deprecated tag without any annotation", () => {
    const source = [
      "package p;",
      "public class Legacy {",
      "    /**",
      "     * Old way.",
      "     *",
      "     * @deprecated use {@link #newWay()} instead",
      "     */",
      "    void oldWay() {}",
      "    void newWay() {}",
      "}",
    ].join("\n");
    const parsed = parseJavaSource(source, "p/Legacy.java");
    const legacy = classByFqn(parsed, "p.Legacy");
    expect(member(legacy, "oldWay").deprecated).toBe(true);
    expect(member(legacy, "newWay").deprecated).toBe(false);
  });
});

describe("graceful degradation", () => {
  it("never throws on unterminated, malformed, or empty input", () => {
    const junk = [
      "class { \\unterminated ",
      "%%%((",
      "",
      "}}}{{{",
      'public class Broken { void f( { ; "unclosed',
    ];
    for (const input of junk) {
      let parsed: SourceFileDeclarations | null = null;
      expect(() => {
        parsed = parseJavaSource(input, "junk.java");
      }, `input ${JSON.stringify(input)} must not throw`).not.toThrow();
      expect(parsed).not.toBeNull();
    }
  });

  it("reports diagnostics for garbage instead of classes or crashes", () => {
    const parsed = parseJavaSource("%%%((", "garbage.java");
    expect(parsed.classes).toEqual([]);
    expect(parsed.diagnostics.length).toBeGreaterThanOrEqual(1);
    const unterminated = parseJavaSource("class { \\unterminated ", "u.java");
    expect(
      unterminated.diagnostics.length >= 1 || unterminated.classes.length === 0,
      "problems must surface as diagnostics or empty output",
    ).toBe(true);
  });

  it("never throws on pseudo-random bytes", () => {
    // deterministic LCG so failures reproduce; latin1 keeps every byte round-tripping
    let state = 0x2f6e2b1;
    const bytes = Buffer.alloc(4096);
    for (let i = 0; i < bytes.length; i++) {
      state = (state * 1103515245 + 12345) % 0x80000000;
      bytes[i] = state & 0xff;
    }
    expect(() => parseJavaSource(bytes.toString("latin1"), "random.java")).not.toThrow();
  });

  it("flags unbalanced braces with a line number", () => {
    const parsed = parseJavaSource("package p;\npublic class A {\n  void f() {\n}\n", "A.java");
    expect(parsed.diagnostics.some((d) => /unbalanced braces at line \d+/.test(d))).toBe(true);
  });
});

describe("round-trip through the sources jar", () => {
  it("parses the jar entry to the same fqn set as the on-disk file", async () => {
    const entries = await listZipEntries(SOURCES_JAR);
    const entry = entries.find((e) => e.name === "com/example/Demo.java");
    expect(entry).toBeDefined();
    const text = await readTextEntry(SOURCES_JAR, entry!);
    const fromJar = parseJavaSource(text, entry!.name);
    const fromFile = parseJavaSource(readFixture("Demo.java"), "com/example/Demo.java");
    expect(fromJar.pkg).toBe("com.example");
    expect(fromJar.diagnostics).toEqual([]);
    expect(fromJar.classes.map((c) => c.fqn).sort()).toEqual(
      fromFile.classes.map((c) => c.fqn).sort(),
    );
    const jarRun = member(classByFqn(fromJar, "com.example.Demo"), "run", "run(String,int)");
    expect(jarRun.signature).toBe("public Object run(String,int)");
  });
});

describe("multi-declarator fields and interface-nested types (synthetic)", () => {
  const source = [
    "package p;",
    "public interface Contract {",
    "    class Impl implements Contract {",
    "        int a, b = 2, c;",
    "        void go() { }",
    "    }",
    "    interface Inner {}",
    "    enum Kind { X }",
    "}",
  ].join("\n");
  const parsed = parseJavaSource(source, "p/Contract.java");
  const contract = classByFqn(parsed, "p.Contract");
  const impl = classByFqn(parsed, "p.Contract.Impl");

  it("each declarator of `int a, b = 2, c;` ends on its own terminator line", () => {
    expect(parsed.diagnostics).toEqual([]);
    const a = member(impl, "a");
    const b = member(impl, "b");
    const c = member(impl, "c");
    // all on line 4; none of them may run to end of file (line 9)
    expect(a.lineEnd).toBe(4);
    expect(b.lineEnd).toBe(4);
    expect(c.lineEnd).toBe(4);
    expect(a.lineEnd).not.toBe(parsed.classes.length + 10);
  });

  it("types nested in an interface are implicitly static (javac ACC_STATIC parity)", () => {
    expect(member(contract, "Impl").static).toBe(true);
    expect(member(contract, "Inner").static).toBe(true);
    expect(member(contract, "Kind").static).toBe(true);
    expect(impl.static).toBe(true);
    expect(classByFqn(parsed, "p.Contract.Inner").static).toBe(true);
  });

  it("an explicitly static nested class in a class is static; a plain one is not", () => {
    const outer = parseJavaSource(
      ["package p;", "public class Plain {", "    static class S {}", "    class I {}", "}"].join("\n"),
      "p/Plain.java",
    );
    const plain = classByFqn(outer, "p.Plain");
    expect(member(plain, "S").static).toBe(true);
    expect(member(plain, "I").static).toBe(false);
  });
});
