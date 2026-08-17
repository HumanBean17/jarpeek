import { describe, expect, it } from "vitest";
import { moduleCoordinates, moduleNamespace } from "../../src/resolver/module-coordinate.js";

describe("module coordinates", () => {
  it("namespaces by the build root: same project shares, different projects never collide", () => {
    const a = "/work/checkout-a";
    const b = "/work/checkout-b";
    expect(moduleCoordinates(a, ":app")).toBe(moduleCoordinates(a, ":app"));
    expect(moduleCoordinates(a, ":app")).not.toBe(moduleCoordinates(b, ":app"));
    expect(moduleNamespace(a)).toMatch(/^[A-Za-z0-9_-]+-[0-9a-f]{8}$/);
  });

  it("keeps the label as the display version: ':app' → 'app', a bare ':' → 'root'", () => {
    expect(moduleCoordinates("/work/demo", ":app").split(":").pop()).toBe("app");
    expect(moduleCoordinates("/work/demo", "a/a1").split(":").pop()).toBe("a/a1");
    expect(moduleCoordinates("/work/demo", ":").split(":").pop()).toBe("root");
  });
});
