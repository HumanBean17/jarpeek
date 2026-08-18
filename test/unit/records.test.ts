import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classRecord,
  isClassEntry,
  isIndexableClass,
  recordsFromClassBytes,
  recordsFromSourceText,
} from "../../src/parse/records.js";
import { listZipEntries, readZipEntry } from "../../src/parse/zip.js";
import type { Declaration } from "../../src/core/types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const DEMO_JAR = join(FIXTURES, "jars", "demo-lib-1.0.0.jar");
const SRC = join(FIXTURES, "src");

async function readClassEntry(entryName: string): Promise<Buffer> {
  const entry = (await listZipEntries(DEMO_JAR)).find((e) => e.name === entryName);
  expect(entry, `jar entry ${entryName}`).toBeDefined();
  return readZipEntry(DEMO_JAR, entry!);
}

describe("recordsFromSourceText", () => {
  it("returns the Demo class record plus its member records sharing the class fqn", () => {
    const text = readFileSync(join(SRC, "java", "com", "example", "Demo.java"), "utf8");
    const { records, diagnostics } = recordsFromSourceText(text, "com/example/Demo.java");
    expect(diagnostics).toEqual([]);

    const classRecords = records.filter((r) => r.selector === r.fqn.slice(r.fqn.lastIndexOf(".") + 1) && r.kind !== "method" && r.kind !== "field");
    expect(classRecords.filter((r) => r.selector === "Demo")).toHaveLength(1);
    const demo = classRecords.find((r) => r.selector === "Demo")!;
    expect(demo.fqn).toBe("com.example.Demo");
    expect(demo.kind).toBe("class");
    expect(demo.signature).toBe("public class Demo");
    // source provenance: line ranges and javadoc survive the move
    expect(demo.lineStart).toBe(9);
    expect(demo.lineEnd).toBe(53);
    expect(demo.javadocStart).toBe(5);

    // members carry the class's fqn and the file name, not their own nesting
    const members = records.filter((r) => r.fqn === "com.example.Demo" && r !== demo);
    expect(members.map((m) => m.selector)).toEqual(["NAME", "run", "run", "old", "Worker"]);
    for (const member of members) {
      expect(member.file).toBe("com/example/Demo.java");
    }
    const run = members.find((m) => m.selector === "run" && m.kind === "method")!;
    expect(run.signature).toBe("public Object run(String,int)");
  });

  it("returns the file's imports and threads javadoc into the flat records", () => {
    const text = [
      "package p;",
      "import java.util.List;",
      "/** Doc. */",
      "public class Q {",
      "    /** Counts. */",
      "    int n;",
      "}",
    ].join("\n");
    const { records, imports } = recordsFromSourceText(text, "p/Q.java");
    expect(imports).toEqual(["import java.util.List;"]);
    const q = records.find((r) => r.selector === "Q")!;
    expect(q.javadoc).toBe("/** Doc. */");
    const n = records.find((r) => r.selector === "n")!;
    expect(n.javadoc).toBe("/** Counts. */");
  });

  it("routes .kt files to the Kotlin lexer", () => {
    const text = readFileSync(join(SRC, "kotlin", "Sample.kt"), "utf8");
    const { records } = recordsFromSourceText(text, "kotlin/Sample.kt");
    const singleton = records.find((r) => r.selector === "Singleton")!;
    expect(singleton.fqn).toBe("com.example.Singleton");
    expect(singleton.kind).toBe("object"); // Kotlin-only kind: only the Kotlin lexer produces it
    const reset = records.find((r) => r.selector === "reset")!;
    expect(reset.fqn).toBe("com.example.Singleton");
    expect(reset.kind).toBe("method");
  });
});

describe("classRecord", () => {
  const base = {
    fqn: "com.example.C",
    kind: "class" as const,
    visibility: "public" as const,
    static: false,
    deprecated: false,
    signature: "public class C",
  };

  it("keeps line fields only when the source carries them", () => {
    const fromSource = classRecord({ ...base, lineStart: 3, lineEnd: 9, javadocStart: 1 }, "com/example/C.java");
    expect(fromSource).toMatchObject({
      fqn: "com.example.C",
      file: "com/example/C.java",
      selector: "C",
      kind: "class",
      lineStart: 3,
      lineEnd: 9,
      javadocStart: 1,
    });
    // class files carry signatures only: no line provenance, no javadoc
    const fromBytes = classRecord(base, "com/example/C.class");
    expect(fromBytes.lineStart).toBeUndefined();
    expect(fromBytes.lineEnd).toBeUndefined();
    expect(fromBytes.javadocStart).toBeUndefined();
    expect(fromBytes.javadoc).toBeUndefined();
  });

  it("threads the raw javadoc block onto the class record", () => {
    const fromSource = classRecord({ ...base, javadoc: "/** C docs. */" }, "com/example/C.java");
    expect(fromSource.javadoc).toBe("/** C docs. */");
  });
});

describe("recordsFromClassBytes", () => {
  it("returns the Demo class record plus members from the jar's Demo.class", async () => {
    const buf = await readClassEntry("com/example/Demo.class");
    const { records, warning } = recordsFromClassBytes(buf, "com/example/Demo.class", "com/example/Demo.class");
    expect(warning).toBeUndefined();

    const demo = records.find((r) => r.selector === "Demo")!;
    expect(demo.fqn).toBe("com.example.Demo");
    expect(demo.kind).toBe("class");
    expect(demo.lineStart).toBeUndefined();

    const members: Declaration[] = records.filter((r) => r !== demo);
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member.fqn).toBe("com.example.Demo");
      expect(member.file).toBe("com/example/Demo.class");
    }
    const run = members.find((m) => m.selector === "run" && m.kind === "method")!;
    expect(run.signature).toBe("public java.lang.Object run(java.lang.String,int)");
  });

  it("drops anonymous classes silently: zero records, no warning", async () => {
    const buf = await readClassEntry("com/example/Outer$1.class");
    const { records, warning } = recordsFromClassBytes(buf, "com/example/Outer$1.class", "com/example/Outer$1.class");
    expect(records).toEqual([]);
    expect(warning).toBeUndefined();
  });

  it("returns zero records and a warning for garbage bytes", () => {
    const { records, warning } = recordsFromClassBytes(Buffer.from("not a class"), "X.class", "demo.jar!X.class");
    expect(records).toEqual([]);
    expect(warning).toContain("failed to index");
    expect(warning).toContain("demo.jar!X.class");
  });
});

describe("entry predicates", () => {
  it("isIndexableClass rejects digit simple names, keeps identifier ones", () => {
    // parseClassFile maps `$` → `.` before this check runs, so the filter sees
    // the dotted form; the raw binary name keeps its `$` segments intact
    expect(isIndexableClass("a.b.Outer.1")).toBe(false);
    expect(isIndexableClass("a.b.Outer$1")).toBe(true); // `.`-segments only, `$` is part of the name
    expect(isIndexableClass("a.b.Outer$Inner")).toBe(true);
    expect(isIndexableClass("a.b.Outer")).toBe(true);
  });

  it("isClassEntry keeps .class entries minus module/package-info", () => {
    expect(isClassEntry("module-info.class")).toBe(false);
    expect(isClassEntry("a/B.class")).toBe(true);
  });
});
