/**
 * JDK pseudo-artifact resolver.
 *
 * The JDK on the machine is a dependency like any other, just one that no
 * build tool reports: sources live at `<javaHome>/lib/src.zip` when the
 * distro ships them. Without that zip there is nothing to serve — the old
 * jimage-extracted class tree was a disk hoarder for signatures a src.zip
 * distro gives away for free, so it is gone. A missing JAVA_HOME or src.zip
 * degrades to `{artifact: null}` with a warning — never a throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";

export interface ResolveJdkOptions {
  javaHome?: string;
}

export interface ResolveJdkResult {
  artifact: DependencyArtifact | null;
  warnings: string[];
}

const NO_JAVA_HOME = "no JAVA_HOME; JDK sources unavailable";
const SRC_ZIP_MISSING = "src.zip missing; JDK classes unavailable";

/** `JAVA_VERSION="25.0.2"` → `25.0.2`; null when the file or line is absent. */
function versionFromRelease(javaHome: string): string | null {
  let release: string;
  try {
    release = readFileSync(join(javaHome, "release"), "utf8");
  } catch {
    return null;
  }
  const match = /^JAVA_VERSION="([^"]+)"/m.exec(release);
  return match === null ? null : match[1];
}

/**
 * Resolve the local JDK as `jdk:<version>` from src.zip alone: version from
 * the `release` file's JAVA_VERSION line, else the install-dir basename.
 */
export async function resolveJdk(opts: ResolveJdkOptions = {}): Promise<ResolveJdkResult> {
  const javaHome = opts.javaHome ?? process.env.JAVA_HOME;
  if (javaHome === undefined || javaHome === "") {
    return { artifact: null, warnings: [NO_JAVA_HOME] };
  }

  // no release file (or no version line) → best guess from the install dir name
  const version = versionFromRelease(javaHome) ?? basename(javaHome);

  const srcZip = join(javaHome, "lib", "src.zip");
  if (!existsSync(srcZip)) {
    return { artifact: null, warnings: [SRC_ZIP_MISSING] };
  }
  return {
    artifact: {
      coordinates: `jdk:${version}`,
      kind: "jdk",
      configuration: "jdk",
      noDecompile: true,
      sourcesJar: srcZip,
    },
    warnings: [],
  };
}
