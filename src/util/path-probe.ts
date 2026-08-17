/**
 * PATH probe for an executable the harness configs will invoke by bare name
 * — the same pattern the gradle/maven resolvers use for their build tools:
 * on win32 any PATHEXT match counts, elsewhere the file must exist and be
 * executable somewhere on PATH.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** True when `command` is reachable as an executable on PATH. */
export function commandOnPath(command: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  if (process.platform === "win32") {
    const exts = (process.env.PATHEXT ?? ".com;.exe;.bat;.cmd")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0);
    return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, `${command}${ext}`))));
  }
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
