/**
 * The shared enum arrays: one source of truth for MCP zod schemas, CLI flag
 * choices, and (through commander's auto-rendering) help text. The order is
 * pinned because it is user-visible — it is the order `Allowed choices are`
 * and `--help` print.
 */
import { describe, expect, it } from "vitest";
import { KIND_VALUES, VISIBILITY_VALUES } from "../../src/core/enums.js";

describe("core enums", () => {
  it("KIND_VALUES lists every DeclKind, in the printed order", () => {
    expect([...KIND_VALUES]).toEqual([
      "class",
      "interface",
      "enum",
      "record",
      "annotation",
      "object",
      "method",
      "constructor",
      "field",
      "property",
      "enum-constant",
    ]);
  });

  it("VISIBILITY_VALUES lists every Visibility, in the printed order", () => {
    expect([...VISIBILITY_VALUES]).toEqual(["public", "protected", "package", "private"]);
  });
});
