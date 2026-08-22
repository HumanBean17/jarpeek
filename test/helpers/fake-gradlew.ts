/**
 * Fake gradle wrappers shared by the subprocess-driving suites
 * (cli.test.ts, output-budget.test.ts).
 *
 * Both platforms' shapes are written unconditionally: `gradlew` (sh) serves
 * unix, `gradlew.bat` (cmd) serves win32 — the resolver picks whichever its
 * platform uses, so no test branches on platform. The succeeding dump is
 * built with JSON.stringify so windows backslash paths arrive properly
 * escaped.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeFakeGradlew(projectRoot: string, jar: string, sourcesJar: string): void {
  const dump = JSON.stringify({
    configurations: [
      {
        name: "compileClasspath",
        dependencies: [{ coordinates: "com.example:demo-lib:1.0.0", kind: "external", path: jar }],
      },
    ],
    sources: { "com.example:demo-lib:1.0.0": sourcesJar },
  });
  const sh = [
    "#!/bin/sh",
    `echo '###JARPEEK-BEGIN###'`,
    `echo '${dump}'`,
    `echo '###JARPEEK-END###'`,
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(projectRoot, "gradlew"), sh, { mode: 0o755 });
  chmodSync(join(projectRoot, "gradlew"), 0o755);
  const bat = [
    "@echo off",
    "echo ###JARPEEK-BEGIN###",
    `echo ${dump}`,
    "echo ###JARPEEK-END###",
    "exit /b 0",
    "",
  ].join("\r\n");
  writeFileSync(join(projectRoot, "gradlew.bat"), bat);
}

/** A wrapper that fails with a fixed stderr tail, so warning text is pinned. */
export function writeFailingGradlew(projectRoot: string, message: string): void {
  const sh = ["#!/bin/sh", `echo '${message}' >&2`, "exit 1", ""].join("\n");
  writeFileSync(join(projectRoot, "gradlew"), sh, { mode: 0o755 });
  chmodSync(join(projectRoot, "gradlew"), 0o755);
  const bat = ["@echo off", `echo ${message} 1>&2`, "exit /b 1", ""].join("\r\n");
  writeFileSync(join(projectRoot, "gradlew.bat"), bat);
}
