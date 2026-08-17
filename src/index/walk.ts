/**
 * Shared directory walk used by the indexer and the staleness checker.
 *
 * One implementation so a source signature covers exactly the files the
 * indexer would parse: same pruning, same keep predicate, same sort.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Directory segments pruned from sourceDir walks (build outputs and VCS dirs). */
const PRUNED_DIR_SEGMENTS = new Set(["build", "target", "out", ".git", "node_modules"]);

/**
 * Collect files under `root` as `/`-separated paths relative to `root`.
 * Source walks prune build-output and VCS directory segments; class walks
 * keep everything (`build/classes/...` is a legitimate classesDir). A
 * directory that cannot be read becomes one `failed to walk` warning and the
 * walk continues — a bad artifact never aborts the run.
 */
export function walkFiles(
  root: string,
  keep: (name: string) => boolean,
  prune: boolean,
  warnings: string[],
): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`failed to walk ${rel.length === 0 ? dir : rel}: ${(e as Error).message}`);
      return;
    }
    for (const item of items) {
      const relPath = rel.length === 0 ? item.name : `${rel}/${item.name}`;
      if (item.isDirectory()) {
        if (prune && PRUNED_DIR_SEGMENTS.has(item.name)) continue;
        walk(join(dir, item.name), relPath);
      } else if (keep(item.name)) {
        out.push(relPath);
      }
    }
  };
  walk(root, "");
  return out.sort();
}

/** True for source file names the indexer parses from sourceDir/source jars. */
export const isSourceEntry = (name: string): boolean => name.endsWith(".java") || name.endsWith(".kt");
