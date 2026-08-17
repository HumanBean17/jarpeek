/**
 * Gated e2e for the Maven resolver.
 *
 * Requires `JARPEEK_E2E` plus a real `mvn` on PATH (and network, to download
 * the fixture POM's dependency and its sources jar). The fixture is shipped
 * as `pom.txt` so the fixtures tree itself is not a Maven project; the test
 * materializes it as `pom.xml` in a temp root and runs the real resolver.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMaven } from "../../src/resolver/maven.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "maven");

describe.skipIf(!process.env.JARPEEK_E2E)("maven e2e (needs JARPEEK_E2E, mvn, and network)", () => {
  it("resolves the fixture POM's dependency through a real mvn run", { timeout: 300_000 }, async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "jarpeek-maven-e2e-"));
    try {
      writeFileSync(join(projectRoot, "pom.xml"), readFileSync(join(FIXTURES, "pom.txt"), "utf8"));

      const resolution = await resolveMaven(projectRoot, { timeoutMs: 240_000 });

      expect(resolution.ok).toBe(true);
      expect(resolution.reason).toBeUndefined();
      const externals = resolution.artifacts.filter((a) => a.kind === "external");
      expect(externals.length).toBeGreaterThanOrEqual(1);
      const commons = externals.find((a) => a.coordinates === "org.apache.commons:commons-lang3:3.14.0");
      expect(commons).toBeDefined(); // the POM's one compile dependency
      for (const artifact of externals) {
        expect(existsSync(artifact.binaryJar!)).toBe(true);
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
