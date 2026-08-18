import { describe, expect, it } from "vitest";
import { resolveSections, type Sections } from "../../src/core/query/outline.js";

const ALL_ON: Sections = { imports: true, fields: true, methods: true, inner: true, javadoc: true };

describe("resolveSections", () => {
  it("maps every preset per the spec table", () => {
    expect(resolveSections("minimal", undefined)).toEqual({
      imports: false,
      fields: false,
      methods: true,
      inner: true,
      javadoc: false,
    });
    // outline and full differ only in CLI rendering, never in data
    expect(resolveSections("outline", undefined)).toEqual(ALL_ON);
    expect(resolveSections("full", undefined)).toEqual(ALL_ON);
  });

  it("undefined preset is the outline preset", () => {
    expect(resolveSections(undefined, undefined)).toEqual(ALL_ON);
  });

  it("any defined override wins over the preset value, per field", () => {
    const revived = resolveSections("minimal", { imports: true });
    expect(revived).toEqual({ ...ALL_ON, fields: false, javadoc: false });
    const silenced = resolveSections("full", { javadoc: false, methods: false });
    expect(silenced).toEqual({ ...ALL_ON, javadoc: false, methods: false });
    const noInner = resolveSections(undefined, { inner: false });
    expect(noInner).toEqual({ ...ALL_ON, inner: false });
  });

  it("empty and undefined-valued overrides equal no overrides", () => {
    expect(resolveSections("minimal", {})).toEqual(resolveSections("minimal", undefined));
    expect(resolveSections("outline", { imports: undefined })).toEqual(ALL_ON);
  });
});
