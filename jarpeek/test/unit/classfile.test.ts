import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Visibility } from "../../src/core/types.js";
import { ClassFileError, parseClassFile } from "../../src/parse/classfile.js";
import { type ZipEntry, listZipEntries, readZipEntry } from "../../src/parse/zip.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");
const NOSOURCES_JAR = join(FIXTURES, "jars", "nosources-lib-1.0.0.jar");
const GOLDEN = join(FIXTURES, "golden");

const entriesByJar = new Map<string, Promise<ZipEntry[]>>();
function entriesOf(jar: string): Promise<ZipEntry[]> {
  let p = entriesByJar.get(jar);
  if (!p) {
    p = listZipEntries(jar);
    entriesByJar.set(jar, p);
  }
  return p;
}

async function parseFromJar(jar: string, entryName: string) {
  const entry = (await entriesOf(jar)).find((e) => e.name === entryName);
  expect(entry, `jar entry ${entryName}`).toBeDefined();
  return parseClassFile(await readZipEntry(jar, entry!));
}

function parseDemoClass(entryName: string) {
  return parseFromJar(DEMO_JAR, entryName);
}

describe("parseClassFile — class header", () => {
  it("parses Demo's fqn, kind, visibility, and source-style signature", async () => {
    const demo = await parseDemoClass("com/example/Demo.class");
    expect(demo.fqn).toBe("com.example.Demo");
    expect(demo.kind).toBe("class");
    expect(demo.visibility).toBe("public");
    expect(demo.static).toBe(false); // top-level class
    expect(demo.deprecated).toBe(false);
    expect(demo.signature).toBe("public class Demo");
  });

  it("maps nested binary names to dotted fqns: $ → . for nesting", async () => {
    const worker = await parseDemoClass("com/example/Demo$Worker.class");
    expect(worker.fqn).toBe("com.example.Demo.Worker");
    expect(worker.kind).toBe("class");
    expect(worker.visibility).toBe("public");
    expect(worker.static).toBe(true); // static nested class via InnerClasses
    expect(worker.signature).toBe("public static class Worker");

    const inner = await parseDemoClass("com/example/Outer$Inner.class");
    expect(inner.fqn).toBe("com.example.Outer.Inner");
    expect(inner.static).toBe(false); // inner (non-static) member class
    expect(inner.signature).toBe("public class Inner");
  });

  it("derives kinds from access flags and the Record superclass", async () => {
    const colors = await parseDemoClass("com/example/Colors.class");
    expect(colors.kind).toBe("enum");
    expect(colors.signature).toBe("public enum Colors");

    const point = await parseDemoClass("com/example/Point.class");
    expect(point.kind).toBe("record"); // javac does not set ACC_RECORD; super is java/lang/Record
    expect(point.signature).toBe("public record Point(int,int)");

    const res = await parseDemoClass("com/example/Res.class");
    expect(res.kind).toBe("annotation"); // ACC_INTERFACE + ACC_ANNOTATION
    expect(res.signature).toBe("public @interface Res");
  });
});

describe("parseClassFile — members", () => {
  it("expands descriptors to fully-qualified signatures (exact strings)", async () => {
    const demo = await parseDemoClass("com/example/Demo.class");
    const run = demo.members.find(
      (m) => m.selector === "run" && m.signature.includes("java.lang.String,int"),
    );
    expect(run).toBeDefined();
    expect(run!.signature).toBe("public java.lang.Object run(java.lang.String,int)");
    expect(run!.kind).toBe("method");
    expect(run!.visibility).toBe("public");
    expect(run!.static).toBe(false);
    expect(run!.deprecated).toBe(false);

    const name = demo.members.find((m) => m.selector === "NAME");
    expect(name).toBeDefined();
    expect(name!.signature).toBe("private static final java.lang.String NAME");
    expect(name!.kind).toBe("field");
    expect(name!.visibility).toBe("private");
    expect(name!.static).toBe(true);
  });

  it("maps <init> to a constructor named after the class and skips <clinit>", async () => {
    const demo = await parseDemoClass("com/example/Demo.class");
    const ctor = demo.members.find((m) => m.kind === "constructor");
    expect(ctor).toBeDefined();
    expect(ctor!.selector).toBe("Demo");
    expect(ctor!.signature).toBe("public Demo()");
    expect(ctor!.visibility).toBe("public");
    expect(demo.members.some((m) => m.selector === "<clinit>")).toBe(false);
    expect(demo.members.some((m) => m.selector === "<init>")).toBe(false);
  });

  it("marks members deprecated from the Deprecated attribute", async () => {
    const demo = await parseDemoClass("com/example/Demo.class");
    const old = demo.members.find((m) => m.selector === "old")!;
    expect(old.deprecated).toBe(true);
    expect(old.visibility).toBe("package"); // `void old()` has no modifier in source
    expect(old.signature).toBe("void old()");
  });

  it("keeps all member declarations free of file and line provenance", async () => {
    const demo = await parseDemoClass("com/example/Demo.class");
    expect(demo.members.length).toBeGreaterThan(0);
    for (const member of demo.members) {
      expect(member.file).toBe("");
      expect(member.lineStart).toBeUndefined();
      expect(member.lineEnd).toBeUndefined();
      expect(member.fqn).toBe("com.example.Demo");
    }
  });

  it("finds the annotation's defaulted value() method", async () => {
    const res = await parseDemoClass("com/example/Res.class");
    const value = res.members.find((m) => m.selector === "value")!;
    expect(value.kind).toBe("method");
    expect(value.visibility).toBe("public");
    expect(value.static).toBe(false);
    expect(value.signature).toBe("public abstract java.lang.String value()");
  });

  it("reads record components as private final int fields with accessors", async () => {
    const point = await parseDemoClass("com/example/Point.class");
    const x = point.members.find((m) => m.selector === "x" && m.kind === "field")!;
    expect(x.signature).toBe("private final int x");
    const y = point.members.find((m) => m.selector === "y" && m.kind === "field")!;
    expect(y.signature).toBe("private final int y");
    expect(point.members.find((m) => m.selector === "x" && m.kind === "method")!.signature).toBe(
      "public int x()",
    );
    expect(point.members.find((m) => m.selector === "y" && m.kind === "method")!.signature).toBe(
      "public int y()",
    );
    expect(point.members.find((m) => m.kind === "constructor")!.signature).toBe(
      "public Point(int,int)",
    );
  });

  it("reads enum constants as enum-constant members with implicit public static", async () => {
    const colors = await parseDemoClass("com/example/Colors.class");
    const names = colors.members.filter((m) => m.kind === "enum-constant").map((m) => m.selector);
    expect(names).toEqual(["RED", "GREEN", "BLUE"]);
    const red = colors.members.find((m) => m.selector === "RED")!;
    expect(red.visibility).toBe("public");
    expect(red.static).toBe(true);
    expect(red.signature).toBe("RED");
    // compiler-synthesized members stay visible, matching javap -p
    const valuesField = colors.members.find((m) => m.selector === "$VALUES")!;
    expect(valuesField.kind).toBe("field");
    expect(valuesField.visibility).toBe("private");
    expect(valuesField.static).toBe(true);
    expect(valuesField.signature).toBe("private static final com.example.Colors[] $VALUES");
    expect(colors.members.find((m) => m.selector === "$values")!.visibility).toBe("private");
    expect(colors.members.find((m) => m.selector === "label")!.signature).toBe(
      "public java.lang.String label()",
    );
  });
});

describe("parseClassFile — javap -p parity", () => {
  interface GoldenMember {
    name: string;
    visibility: Visibility;
    static: boolean;
  }

  /**
   * Parse member lines out of a committed `javap -p` golden. Skips the
   * "Compiled from" header, the class wrapper line, and the closing brace.
   * `static {};` is javap's rendering of `<clinit>`, which the reader skips
   * by contract, so it is dropped here too.
   */
  function parseGolden(text: string): GoldenMember[] {
    const members: GoldenMember[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (line.startsWith("Compiled from")) continue;
      if (line === "}") continue;
      if (line.endsWith("{")) continue; // `public class com.example.Demo {` wrapper
      if (/^static\s*\{\};?$/.test(line)) continue; // <clinit>
      const visibility: Visibility = /(^|\s)public\b/.test(line)
        ? "public"
        : /(^|\s)private\b/.test(line)
          ? "private"
          : /(^|\s)protected\b/.test(line)
            ? "protected"
            : "package";
      const isStatic = /(^|\s)static\b/.test(line);
      let name: string;
      if (line.includes("(")) {
        const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(line);
        expect(m, `golden member line has a name: ${line}`).not.toBeNull();
        name = m![1]!;
      } else {
        const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(\[\])*\s*;?$/.exec(line.replace(/;$/, ""));
        expect(m, `golden member line has a name: ${line}`).not.toBeNull();
        name = m![1]!;
      }
      members.push({ name, visibility, static: isStatic });
    }
    return members;
  }

  function expectJavapParity(classFileEntry: string, goldenFile: string) {
    return async () => {
      const parsed = await parseDemoClass(classFileEntry);
      const golden = parseGolden(readFileSync(join(GOLDEN, goldenFile), "utf8"));
      expect(golden.length).toBeGreaterThan(0);

      const key = (name: string, visibility: Visibility, static_: boolean) =>
        `${name}|${visibility}|${static_}`;
      const parsedKeys = new Set(parsed.members.map((m) => key(m.selector, m.visibility, m.static)));
      // every javap-listed member (deduped: `run` overloads share a key) exists
      for (const member of golden) {
        expect(
          parsedKeys,
          `javap lists ${member.name} (${member.visibility}${member.static ? " static" : ""})`,
        ).toContain(key(member.name, member.visibility, member.static));
      }
      // counts match exactly: javap -p and the reader agree on the full member
      // set, compiler-synthesized members included ($VALUES, $values, values…)
      expect(parsed.members.length).toBe(golden.length);
    };
  }

  it("Demo's member set matches golden/Demo.javap.txt", expectJavapParity("com/example/Demo.class", "Demo.javap.txt"));

  it("Colors' member set matches golden/Colors.javap.txt", expectJavapParity("com/example/Colors.class", "Colors.javap.txt"));

  it("Outer's member set matches golden/Outer.javap.txt (lambda + InvokeDynamic pool path)", async () => {
    // Outer is the only committed fixture with a lambda: its class file pulls
    // InvokeDynamic and InterfaceMethodref constants through the pool walk
    const outer = await parseDemoClass("com/example/Outer.class");
    expect(outer.fqn).toBe("com.example.Outer");
    expect(outer.kind).toBe("class");
    const lambda = outer.members.find((m) => m.selector === "lambda$dispatch$0")!;
    expect(lambda.visibility).toBe("private");
    expect(lambda.static).toBe(true);
    await expectJavapParity("com/example/Outer.class", "Outer.javap.txt")();
  });
});

describe("parseClassFile — nosources jar", () => {
  it("reads Hidden from the binary jar with no sources", async () => {
    const hidden = await parseFromJar(NOSOURCES_JAR, "com/example/nosources/Hidden.class");
    expect(hidden.fqn).toBe("com.example.nosources.Hidden");
    expect(hidden.kind).toBe("class");
    const secret = hidden.members.find((m) => m.selector === "secret")!;
    expect(secret.signature).toBe("public java.lang.String secret()");
  });
});

describe("parseClassFile — crafted class files", () => {
  const u1b = (v: number) => Buffer.from([v]);
  const u2b = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v);
    return b;
  };
  const u4b = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
  };
  const utf8 = (s: string) =>
    Buffer.concat([u1b(1), u2b(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);
  const cls = (nameIndex: number) => Buffer.concat([u1b(7), u2b(nameIndex)]);

  /**
   * The committed fixtures have no generic members, so this hand-builds a
   * minimal class file to exercise the `Signature` attribute path: type
   * parameters, type variables, wildcards, and the `[I` array descriptor.
   */
  function craftGenericClass(): Buffer {
    // pool layout (indexes are 1-based; count field will be 17)
    const pool: Buffer[] = [
      utf8("Gen"), // 1
      cls(1), // 2 Class Gen
      utf8("java/lang/Object"), // 3
      cls(3), // 4 Class java/lang/Object
      utf8("matrix"), // 5
      utf8("[I"), // 6
      utf8("names"), // 7
      utf8("Ljava/util/List;"), // 8
      utf8("<T:Ljava/lang/Object;>Ljava/util/List<TT;>;"), // 9 field Signature
      utf8("pick"), // 10
      utf8("(Ljava/lang/Object;)Ljava/lang/Object;"), // 11
      utf8("<T:Ljava/lang/Object;>(TT;)TT;"), // 12 method Signature
      utf8("Signature"), // 13 attribute name
      utf8("wild"), // 14
      utf8("Ljava/util/Map;"), // 15
      utf8("Ljava/util/Map<Ljava/lang/String;+Ljava/lang/Number;>;"), // 16 field Signature
    ];
    const signatureAttr = (sigIndex: number) => Buffer.concat([u2b(13), u4b(2), u2b(sigIndex)]);
    const member = (flags: number, nameIndex: number, descIndex: number, sigIndex?: number) =>
      Buffer.concat([
        u2b(flags),
        u2b(nameIndex),
        u2b(descIndex),
        u2b(sigIndex === undefined ? 0 : 1),
        ...(sigIndex === undefined ? [] : [signatureAttr(sigIndex)]),
      ]);

    return Buffer.concat([
      u4b(0xcafebabe),
      u2b(0), // minor
      u2b(52), // major
      u2b(pool.length + 1), // constant-pool count
      ...pool,
      u2b(0x0021), // ACC_PUBLIC | ACC_SUPER
      u2b(2), // this_class
      u2b(4), // super_class
      u2b(0), // interfaces count
      u2b(3), // fields count
      member(0x0009, 5, 6), // public static int[] matrix — no Signature, descriptor only
      member(0x0001, 7, 8, 9), // public List<T> names
      member(0x0002, 14, 15, 16), // private Map<String, ? extends Number> wild
      u2b(1), // methods count
      member(0x0001, 10, 11, 12), // public <T> T pick(T)
      u2b(0), // class attribute count
    ]);
  }

  it("renders generic Signature attributes and the [I array descriptor", () => {
    const parsed = parseClassFile(craftGenericClass());
    expect(parsed.fqn).toBe("Gen");
    expect(parsed.kind).toBe("class");
    expect(parsed.signature).toBe("public class Gen");
    expect(parsed.members.find((m) => m.selector === "matrix")!.signature).toBe(
      "public static int[] matrix",
    );
    expect(parsed.members.find((m) => m.selector === "names")!.signature).toBe(
      "public java.util.List<T> names",
    );
    expect(parsed.members.find((m) => m.selector === "wild")!.signature).toBe(
      "private java.util.Map<java.lang.String,? extends java.lang.Number> wild",
    );
    expect(parsed.members.find((m) => m.selector === "pick")!.signature).toBe(
      "public <T> T pick(T)",
    );
  });

  /**
   * No committed fixture carries Long/Double/Integer/Float/MethodType/Dynamic/
   * Module/Package constants, so this pins every remaining constant-pool skip
   * size at once: the Utf8 entries the field references sit at indexes 17 and
   * 18, reachable only when the Long at 5 and the Double at 7 each consume
   * two slots and every other tag advances by its exact payload size. Any
   * wrong size misaligns the pool and fails the Utf8 dereference or the parse.
   */
  it("walks every constant-pool skip size with Long/Double double-slot alignment", () => {
    const payload4 = Buffer.alloc(4, 0x5a);
    const payload8 = Buffer.alloc(8, 0x5a);
    const pool: Buffer[] = [
      utf8("Slots"), // 1
      cls(1), // 2 Class Slots
      utf8("java/lang/Object"), // 3
      cls(3), // 4 Class java/lang/Object
      Buffer.concat([u1b(5), payload8]), // 5 CONSTANT_Long — occupies slots 5 and 6
      Buffer.concat([u1b(6), payload8]), // 7 CONSTANT_Double — occupies slots 7 and 8
      Buffer.concat([u1b(3), payload4]), // 9 CONSTANT_Integer (4 payload bytes)
      Buffer.concat([u1b(4), payload4]), // 10 CONSTANT_Float (4)
      Buffer.concat([u1b(16), u2b(1)]), // 11 CONSTANT_MethodType (2)
      Buffer.concat([u1b(15), u1b(1), u2b(2)]), // 12 CONSTANT_MethodHandle (3)
      Buffer.concat([u1b(17), u2b(0), u2b(0)]), // 13 CONSTANT_Dynamic (4)
      Buffer.concat([u1b(18), u2b(0), u2b(0)]), // 14 CONSTANT_InvokeDynamic (4)
      Buffer.concat([u1b(19), u2b(1)]), // 15 CONSTANT_Module (2)
      Buffer.concat([u1b(20), u2b(1)]), // 16 CONSTANT_Package (2)
      utf8("sum"), // 17 field name — only resolvable when the walk stayed aligned
      utf8("J"), // 18 field descriptor (long)
    ];

    const buf = Buffer.concat([
      u4b(0xcafebabe),
      u2b(0), // minor
      u2b(52), // major
      u2b(pool.length + 3), // constant-pool count = 19: 16 entries + 2 double-slot holes
      ...pool,
      u2b(0x0021), // ACC_PUBLIC | ACC_SUPER
      u2b(2), // this_class
      u2b(4), // super_class
      u2b(0), // interfaces count
      u2b(1), // fields count
      u2b(0x0002), // private
      u2b(17), // name → "sum"
      u2b(18), // descriptor → J
      u2b(0), // field attribute count
      u2b(0), // methods count
      u2b(0), // class attribute count
    ]);

    const parsed = parseClassFile(buf);
    expect(parsed.fqn).toBe("Slots");
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]!.selector).toBe("sum");
    expect(parsed.members[0]!.signature).toBe("private long sum");
  });
});

describe("parseClassFile — malformed input", () => {
  it("throws ClassFileError for a truncated class (first 20 bytes)", async () => {
    const entry = (await entriesOf(DEMO_JAR)).find((e) => e.name === "com/example/Demo.class")!;
    const truncated = (await readZipEntry(DEMO_JAR, entry)).subarray(0, 20);
    expect(() => parseClassFile(truncated)).toThrow(ClassFileError);
  });

  it("throws ClassFileError for random bytes without the magic", () => {
    // deterministic pseudo-random garbage: none of the runs below starts with CAFEBABE
    const random = Buffer.alloc(100);
    for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff;
    expect(() => parseClassFile(random)).toThrow(ClassFileError);
    expect(() => parseClassFile(Buffer.alloc(100))).toThrow(ClassFileError); // all zeros
    expect(() => parseClassFile(Buffer.alloc(0))).toThrow(ClassFileError); // empty
  });

  it("throws ClassFileError for a valid magic followed by garbage", () => {
    const bogus = Buffer.alloc(64);
    bogus.writeUInt32BE(0xcafebabe, 0);
    bogus.writeUInt16BE(0, 4); // minor
    bogus.writeUInt16BE(52, 6); // major
    bogus.writeUInt16BE(0xffff, 8); // absurd constant-pool count → truncated pool
    expect(() => parseClassFile(bogus)).toThrow(ClassFileError);
  });
});
