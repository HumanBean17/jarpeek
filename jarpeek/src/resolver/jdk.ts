/**
 * JDK pseudo-artifact resolver.
 *
 * The JDK on the machine is a dependency like any other, just one that no
 * build tool reports: sources live at `<javaHome>/lib/src.zip` when the
 * distro ships them. Without that zip the best available truth is the
 * runtime image itself — `jimage extract` turns `<javaHome>/lib/modules`
 * into a class-file tree, which parses to signatures but never bodies.
 * Extraction is expensive and version-stable, so it lands in the cache dir
 * under the JDK version and is reused on later runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DependencyArtifact } from "../core/types.js";
import { ensureCacheDir } from "../util/cache-dir.js";
import { runWithTimeout, type RunResult } from "../util/exec.js";

export interface ResolveJdkOptions {
  javaHome?: string;
  cacheDir?: string;
  runJimage?: (args: string[], o?: object) => Promise<RunResult>;
}

export interface ResolveJdkResult {
  artifact: DependencyArtifact | null;
  warnings: string[];
}

const NO_JAVA_HOME = "no JAVA_HOME; JDK sources unavailable";
const VERSION_UNKNOWN = "jdk-version-unknown";
const SRC_ZIP_MISSING = "src.zip missing; using jimage-extracted class files (signatures only)";
const JIMAGE_FAILED = "jimage extract failed";

const defaultRunJimage = (args: string[], o: object = {}): Promise<RunResult> => runWithTimeout("jimage", args, o);

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
 * Resolve the local JDK as `jdk:<version>`: src.zip when present (full
 * sources), otherwise a jimage-extracted class tree (signatures only). A
 * missing JAVA_HOME or failed extraction degrades to `{artifact: null}` with
 * a warning — never a throw.
 */
export async function resolveJdk(opts: ResolveJdkOptions = {}): Promise<ResolveJdkResult> {
  const javaHome = opts.javaHome ?? process.env.JAVA_HOME;
  if (javaHome === undefined || javaHome === "") {
    return { artifact: null, warnings: [NO_JAVA_HOME] };
  }

  // no release file (or no version line) → best guess from the install dir name
  const releaseVersion = versionFromRelease(javaHome);
  const version = releaseVersion ?? basename(javaHome);
  const baseWarnings = releaseVersion === null ? [VERSION_UNKNOWN] : [];

  const srcZip = join(javaHome, "lib", "src.zip");
  if (existsSync(srcZip)) {
    return {
      artifact: {
        coordinates: `jdk:${version}`,
        kind: "jdk",
        configuration: "jdk",
        noDecompile: true,
        sourcesJar: srcZip,
        provenance: "source",
        warnings: [...baseWarnings],
      },
      warnings: [...baseWarnings],
    };
  }

  // signature fallback: extract the runtime image into the cache, once per version
  const warnings = [...baseWarnings, SRC_ZIP_MISSING];
  const extractDir = join(opts.cacheDir ?? ensureCacheDir(), "v1", "jdk-modules", version);
  if (!existsSync(extractDir)) {
    const runJimage = opts.runJimage ?? defaultRunJimage;
    try {
      const result = await runJimage(["extract", "--dir", extractDir, join(javaHome, "lib", "modules")]);
      if (result.code !== 0 || !existsSync(extractDir)) {
        // extraction produced nothing usable; drop the "using extracted files" claim
        return { artifact: null, warnings: [...baseWarnings, JIMAGE_FAILED] };
      }
    } catch {
      return { artifact: null, warnings: [...baseWarnings, JIMAGE_FAILED] };
    }
  }

  return {
    artifact: {
      coordinates: `jdk:${version}`,
      kind: "jdk",
      configuration: "jdk",
      noDecompile: true,
      classesDir: extractDir,
      provenance: "signature",
      warnings: [...warnings],
    },
    warnings: [...warnings],
  };
}
