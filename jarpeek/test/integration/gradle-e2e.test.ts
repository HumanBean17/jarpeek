/**
 * Gated e2e for the Gradle resolver.
 *
 * Requires both `JARPEEK_E2E` in the environment and a committed fixture
 * Gradle project with its wrapper (`test/fixtures/e2e/gradlew`, plus
 * `settings.gradle[.kts]` and a build script with at least one external
 * dependency). The fixture is authored on a machine with a Gradle
 * distribution — `gradle wrapper` must run once to vendor the wrapper jar —
 * so until it exists this suite self-skips everywhere.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveGradle } from "../../src/resolver/gradle.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "e2e");

describe.skipIf(
  !process.env.JARPEEK_E2E || !existsSync("test/fixtures/e2e/gradlew"),
)("gradle e2e (needs JARPEEK_E2E and the fixture wrapper)", () => {
  it("resolves the fixture project's dependencies through a real Gradle run", async () => {
    const resolution = await resolveGradle(FIXTURE_ROOT);

    expect(resolution.ok).toBe(true);
    expect(resolution.reason).toBeUndefined();
    const externals = resolution.artifacts.filter((a) => a.kind === "external");
    expect(externals.length).toBeGreaterThanOrEqual(1);
    for (const artifact of externals) {
      expect(existsSync(artifact.binaryJar!)).toBe(true);
    }
  });
});
