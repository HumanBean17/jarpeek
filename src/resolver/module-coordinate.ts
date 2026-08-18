/**
 * Module coordinates: build-module identity that stays unique across
 * projects.
 *
 * Coordinates are keyed by string alone, so a bare Gradle project path
 * (`:app`) would collide with every other project's identically named
 * `:app`. Module coordinates therefore carry a namespace derived from the
 * build root's absolute path: same project → same namespace (coordinates
 * survive re-resolves), different projects → different namespaces (never
 * collide).
 */
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

/**
 * Stable per-project namespace: root directory name plus 8 hex chars of the
 * sha256 of its absolute path. The name keeps coordinates readable in tool
 * output; the hash is what separates same-named projects.
 */
export function moduleNamespace(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  const name = basename(absolute).replace(/[^A-Za-z0-9_-]+/g, "_") || "root";
  return `${name}-${hash}`;
}

/**
 * Coordinates for one build module: `module:<namespace>:<label>`, the label
 * being the Gradle project path (":app" → "app") or the project-relative
 * module directory ("a/a1"). The last `:`-segment stays the display version
 * (`ClassHit.version`), so `module:demo-1a2b3c4d:app` reads as "app".
 */
export function moduleCoordinates(projectRoot: string, label: string): string {
  const suffix = label.replace(/^:/, "");
  return `module:${moduleNamespace(projectRoot)}:${suffix.length > 0 ? suffix : "root"}`;
}
