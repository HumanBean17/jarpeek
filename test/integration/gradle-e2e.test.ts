/**
 * Gated e2e for the Gradle resolver.
 *
 * Requires `JARPEEK_E2E` in the environment plus network: it runs the
 * committed fixture project's own wrapper (`test/fixtures/e2e/gradle/`,
 * generated once with `gradle wrapper --gradle-version 9.7.0`; the wrapper
 * jar is Gradle's redistributable bootstrap) against a real dependency
 * (commons-lang3) through the injected Groovy init script. A first run
 * downloads the Gradle distribution and the dependency into ~/.gradle.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveGradle } from "../../src/resolver/gradle.js";

const FIXTURE_PROJECT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "e2e",
  "gradle",
);

describe.skipIf(
  !process.env.JARPEEK_E2E || !existsSync(join(FIXTURE_PROJECT, "gradlew")),
)("gradle e2e (needs JARPEEK_E2E, network, and the fixture wrapper)", () => {
  it("resolves the fixture project's dependencies through a real Gradle run", { timeout: 300_000 }, async () => {
    const resolution = await resolveGradle(FIXTURE_PROJECT, { timeoutMs: 240_000 });

    expect(resolution.ok).toBe(true);
    expect(resolution.reason).toBeUndefined();
    const externals = resolution.artifacts.filter((a) => a.kind === "external");
    expect(externals.length).toBeGreaterThanOrEqual(1);
    const commons = externals.find((a) => a.coordinates === "org.apache.commons:commons-lang3:3.14.0");
    expect(commons).toBeDefined(); // the fixture's one implementation dependency
    expect(commons!.sourcesJar).toBeDefined(); // ...with its sources jar resolved
    for (const artifact of externals) {
      expect(existsSync(artifact.binaryJar!)).toBe(true);
    }
  });

  it("reports the build's own root project as a kind:project artifact with its source root", { timeout: 300_000 }, async () => {
    // the projects pass of the init script, through a real Gradle: the
    // fixture's own src/main/java must arrive as a package root that exists
    const resolution = await resolveGradle(FIXTURE_PROJECT, { timeoutMs: 240_000 });

    expect(resolution.ok).toBe(true);
    const project = resolution.artifacts.find((a) => a.kind === "project");
    expect(project).toBeDefined();
    expect(project!.sourceDirs).toContain(join(FIXTURE_PROJECT, "src", "main", "java"));
    expect(project!.sourceDirs!.every((dir) => existsSync(dir) || dir.endsWith("src/test/java"))).toBe(
      true,
    );
    // resources never join the roots
    expect(project!.sourceDirs!.some((dir) => dir.endsWith("resources"))).toBe(false);
  });
});
