/**
 * Build-system detection for the resolver facade.
 *
 * Detection is marker-file based and intentionally shallow: jarpeek never
 * walks the tree guessing at multi-module layouts — the resolvers themselves
 * handle submodules once the top-level tool family is known. A project with
 * both marker families is not an error; the cascade order in `index.ts`
 * simply tries Gradle first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BuildSystem = "gradle" | "maven";

/** Any one of these at the project root marks a Gradle build. */
const GRADLE_MARKERS = [
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
  "gradlew.bat",
] as const;

/**
 * Build systems present at `projectRoot`, in cascade order: gradle before
 * maven (gradle's dependency dump is richer — configurations and module
 * source dirs — so it wins ties). Empty for a directory with no markers.
 */
export function detectBuildSystems(projectRoot: string): BuildSystem[] {
  const systems: BuildSystem[] = [];
  if (GRADLE_MARKERS.some((marker) => existsSync(join(projectRoot, marker)))) {
    systems.push("gradle");
  }
  if (existsSync(join(projectRoot, "pom.xml"))) systems.push("maven");
  return systems;
}
