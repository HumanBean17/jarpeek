import { describe, expect, it } from "vitest";
import type { Declaration, DeclKind, Visibility } from "../../src/core/types.js";
import type { Sections } from "../../src/core/query/outline.js";
import { renderSkeleton, summarizeJavadoc } from "../../src/cli/skeleton.js";

const ALL: Sections = { imports: true, fields: true, methods: true, inner: true, javadoc: true };
const NO_JAVADOC: Sections = { ...ALL, javadoc: false };

/** Hand-built row: everything the renderer reads, nothing it does not. */
function row(fields: {
  fqn: string;
  selector: string;
  kind: DeclKind;
  signature: string;
  javadoc?: string;
}): Declaration {
  return {
    file: "a/b/Demo.java",
    visibility: "public" as Visibility,
    static: false,
    deprecated: false,
    ...fields,
  };
}

const DEMO_CLASS = row({ fqn: "a.b.Demo", selector: "Demo", kind: "class", signature: "public class Demo" });

describe("renderSkeleton layout", () => {
  it("renders comment metadata, package, and the class shell", () => {
    const out = renderSkeleton(
      { fqn: "a.b.Demo", coordinates: "g:a:1", provenance: "source", rows: [DEMO_CLASS] },
      ALL,
      "summary",
    );
    expect(out).toBe(
      ["// a.b.Demo", "// g:a:1  provenance source", "", "package a.b;", "", "public class Demo {", "}"].join("\n"),
    );
  });

  it("adds the stale comment line when the flag is set", () => {
    const out = renderSkeleton(
      { fqn: "a.b.Demo", coordinates: "g:a:1", provenance: "source", stale: true, rows: [DEMO_CLASS] },
      ALL,
      "summary",
    );
    expect(out.split("\n").slice(0, 3)).toEqual([
      "// a.b.Demo",
      "// g:a:1  provenance source",
      "// stale index served",
    ]);
  });

  it("omits the package line for a dotless fqn", () => {
    const cls = row({ fqn: "Demo", selector: "Demo", kind: "class", signature: "public class Demo" });
    const out = renderSkeleton(
      { fqn: "Demo", coordinates: "g:a:1", provenance: "source", rows: [cls] },
      ALL,
      "summary",
    );
    expect(out).toBe(
      ["// Demo", "// g:a:1  provenance source", "", "public class Demo {", "}"].join("\n"),
    );
  });

  it("renders imports verbatim, one per line, and skips them when absent", () => {
    const withImports = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [DEMO_CLASS],
        imports: ["import java.net.URI;", "import static java.util.Objects.requireNonNull;"],
      },
      ALL,
      "summary",
    );
    expect(withImports).toContain(
      ["package a.b;", "import java.net.URI;", "import static java.util.Objects.requireNonNull;", ""].join("\n"),
    );
    const without = renderSkeleton(
      { fqn: "a.b.Demo", coordinates: "g:a:1", provenance: "source", rows: [DEMO_CLASS] },
      ALL,
      "summary",
    );
    expect(without).not.toContain("import ");
  });

  it("renders members as `signature;` lines in row order, indented 4 spaces", () => {
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          DEMO_CLASS,
          row({ fqn: "a.b.Demo", selector: "NAME", kind: "field", signature: "private static final String NAME" }),
          row({ fqn: "a.b.Demo", selector: "run", kind: "method", signature: "public Object run(String,int)" }),
        ],
      },
      ALL,
      "summary",
    );
    expect(out).toContain(
      ["public class Demo {", "    private static final String NAME;", "    public Object run(String,int);", "}"].join(
        "\n",
      ),
    );
  });

  it("nests nested classes one level deeper per segment, members inside", () => {
    const out = renderSkeleton(
      {
        fqn: "a.b.Outer",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          row({ fqn: "a.b.Outer", selector: "Outer", kind: "class", signature: "public class Outer" }),
          row({ fqn: "a.b.Outer", selector: "dispatch", kind: "method", signature: "public void dispatch(String)" }),
          row({ fqn: "a.b.Outer.Inner", selector: "Inner", kind: "class", signature: "public class Inner" }),
          row({ fqn: "a.b.Outer.Inner", selector: "describe", kind: "method", signature: "public String describe()" }),
          row({ fqn: "a.b.Outer.Inner.Deep", selector: "Deep", kind: "class", signature: "class Deep" }),
          row({ fqn: "a.b.Outer.Inner.Deep", selector: "leaf", kind: "method", signature: "void leaf()" }),
        ],
      },
      ALL,
      "summary",
    );
    expect(out).toContain(
      [
        "public class Outer {",
        "    public void dispatch(String);",
        "    public class Inner {",
        "        public String describe();",
        "        class Deep {",
        "            void leaf();",
        "        }",
        "    }",
        "}",
      ].join("\n"),
    );
  });

  it("renders without a class shell when the rows carry no target class row", () => {
    // the --kind filter can strip the class row; members still render, bare
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [row({ fqn: "a.b.Demo", selector: "run", kind: "method", signature: "public Object run(String,int)" })],
      },
      ALL,
      "summary",
    );
    expect(out).toBe(
      [
        "// a.b.Demo",
        "// g:a:1  provenance source",
        "",
        "package a.b;",
        "",
        "public Object run(String,int);",
      ].join("\n"),
    );
  });
});

describe("renderSkeleton javadoc and detail", () => {
  const RUN_DOC = ["/**", "     * Runs the demo.", "     * @param input the input", "     * @return the result", "     */"].join(
    "\n",
  );

  it("summary detail: one-line javadoc above the member, block tags dropped, first sentence kept", () => {
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          DEMO_CLASS,
          row({
            fqn: "a.b.Demo",
            selector: "run",
            kind: "method",
            signature: "public Object run(String,int)",
            javadoc: RUN_DOC,
          }),
        ],
      },
      ALL,
      "summary",
    );
    expect(out).toContain(
      ["    /** Runs the demo. */", "    public Object run(String,int);"].join("\n"),
    );
  });

  it("summary detail: no summary line when the javadoc yields an empty summary", () => {
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          DEMO_CLASS,
          row({
            fqn: "a.b.Demo",
            selector: "run",
            kind: "method",
            signature: "public Object run(String,int)",
            javadoc: ["/**", "     * @param x nothing to say", "     */"].join("\n"),
          }),
        ],
      },
      ALL,
      "summary",
    );
    expect(out).not.toContain("/**");
  });

  it("full detail: raw javadoc lines indented above the member; method lines end ` { … }`", () => {
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          DEMO_CLASS,
          row({
            fqn: "a.b.Demo",
            selector: "NAME",
            kind: "field",
            signature: "private static final String NAME",
            javadoc: "/** The name. */",
          }),
          row({
            fqn: "a.b.Demo",
            selector: "run",
            kind: "method",
            signature: "public Object run(String,int)",
            javadoc: RUN_DOC,
          }),
          row({ fqn: "a.b.Demo", selector: "Demo", kind: "constructor", signature: "public Demo()" }),
        ],
      },
      ALL,
      "full",
    );
    expect(out).toContain(
      [
        "    /** The name. */",
        "    private static final String NAME;",
        "    /**",
        "     * Runs the demo.",
        "     * @param input the input",
        "     * @return the result",
        "     */",
        "    public Object run(String,int) { … }",
        "    public Demo() { … }",
        "}",
      ].join("\n"),
    );
  });

  it("never clips: a 200-char signature renders verbatim", () => {
    const long = `void ${"x".repeat(187)}(String)`;
    expect(long.length).toBe(200);
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          DEMO_CLASS,
          row({ fqn: "a.b.Demo", selector: "big", kind: "method", signature: long }),
        ],
      },
      ALL,
      "summary",
    );
    expect(out).toContain(`    ${long};`);
  });

  it("sections.javadoc false renders no javadoc even when rows carry it", () => {
    const out = renderSkeleton(
      {
        fqn: "a.b.Demo",
        coordinates: "g:a:1",
        provenance: "source",
        rows: [
          { ...DEMO_CLASS, javadoc: "/** Class doc. */" },
          row({
            fqn: "a.b.Demo",
            selector: "run",
            kind: "method",
            signature: "public Object run(String,int)",
            javadoc: RUN_DOC,
          }),
        ],
      },
      NO_JAVADOC,
      "summary",
    );
    expect(out).not.toContain("/**");
    expect(out).toContain("    public Object run(String,int);");
  });
});

describe("summarizeJavadoc", () => {
  it("joins lines, keeps the first sentence including its period", () => {
    expect(
      summarizeJavadoc(["/**", "     * First sentence. Second one", "     * continues here.", "     */"].join("\n")),
    ).toBe("First sentence.");
  });

  it("cuts at the first block tag, dropping tag text", () => {
    expect(
      summarizeJavadoc(
        ["/**", "     * Runs the demo.", "     *", "     * @param input the input", "     * @return the result", "     */"].join(
          "\n",
        ),
      ),
    ).toBe("Runs the demo.");
  });

  it("keeps inline {@link …} as plain text", () => {
    expect(summarizeJavadoc("/** Use {@link #run()} instead. Really. */")).toBe("Use {@link #run()} instead.");
  });

  it("returns the whole text when there is no period", () => {
    expect(summarizeJavadoc("/** No terminal punctuation here */")).toBe("No terminal punctuation here");
  });

  it("caps at 180 chars with an ellipsis when cut", () => {
    const summary = summarizeJavadoc(`/** ${"word ".repeat(60)}end. */`);
    expect(summary.length).toBe(181);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toContain(".");
  });

  it("returns empty string for a body with no description", () => {
    expect(summarizeJavadoc(["/**", "     * @param x nothing", "     */"].join("\n"))).toBe("");
    expect(summarizeJavadoc("/**/")).toBe("");
    expect(summarizeJavadoc("/***/")).toBe("");
  });
});
