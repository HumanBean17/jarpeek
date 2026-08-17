#!/usr/bin/env node
/**
 * Builds the committed fixture jars under test/fixtures/jars.
 *
 * Deterministic: every entry carries the fixed --date timestamp and entries
 * are added in sorted path order, so reruns on the same JDK produce
 * byte-identical jars. The sources jar and nosources jar are created with
 * --no-manifest to keep them free of JDK-version-dependent manifest bytes;
 * the demo jar keeps the jar tool's manifest on purpose (fixture consumers
 * read META-INF/MANIFEST.MF).
 *
 * Requires javac and jar (JDK 9+) on PATH. Run: node scripts/build-fixtures.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG_ROOT, "test/fixtures/src/java");
const NOSOURCES_SRC = join(PKG_ROOT, "test/fixtures/src-nosources/java");
const RESOURCES = join(PKG_ROOT, "test/fixtures/src/resources");
const OUT_DIR = join(PKG_ROOT, "test/fixtures/jars");
const GOLDEN_DIR = join(PKG_ROOT, "test/fixtures/golden");
const JAR_DATE = "2020-01-01T00:00:00Z";

/** 8 bytes with a NUL in the middle: binary-sniff fixture for logo.png. */
const LOGO_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]);

const BIG_SERVICE_METHODS = 100;

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
}

/** Recursively list file paths under root as sorted, /-separated relative paths. */
function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else files.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return files.sort();
}

function bigServiceSource() {
  const lines = [
    "package com.example;",
    "",
    "/**",
    " * Generated stress fixture: one class, 100 public methods.",
    " */",
    "public class BigService {",
    "",
  ];
  for (let i = 0; i < BIG_SERVICE_METHODS; i++) {
    lines.push(`    /** Method m${i} returns the seed shifted by ${i}. */`);
    lines.push(`    public int m${i}(int seed) {`);
    lines.push(`        return seed + ${i};`);
    lines.push("    }");
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

function createJar(file, { manifest = true } = {}) {
  const args = ["--create", `--date=${JAR_DATE}`, "--file", file];
  if (!manifest) args.push("--no-manifest");
  return args;
}

function summary(label, jarPath) {
  const listing = execFileSync("jar", ["--list", "--file", jarPath], { encoding: "utf8" });
  const entries = listing.split("\n").filter((l) => l.length > 0);
  console.log(`wrote ${relative(PKG_ROOT, jarPath)}: ${entries.length} entries`);
  return { label, entries };
}

/** The demo classes whose `javap -p` output becomes a committed golden. */
const DEMO_GOLDENS = [
  "com.example.Demo",
  "com.example.Demo$Worker",
  "com.example.Outer",
  "com.example.Outer$Inner",
  "com.example.Colors",
  "com.example.Point",
  "com.example.Res",
];

/**
 * Emit one `javap -p` golden for the class-file reader's parity tests. Run
 * against the tmp classes dir before cleanup; the committed golden is then
 * compared at test time without needing javap on PATH.
 */
function writeJavapGolden(classesDir, binaryName) {
  const fileName = `${binaryName.split(".").pop()}.javap.txt`;
  const out = execFileSync("javap", ["-p", "-classpath", classesDir, binaryName], {
    encoding: "utf8",
  });
  writeFileSync(join(GOLDEN_DIR, fileName), out);
  console.log(`wrote test/fixtures/golden/${fileName}`);
}

function main() {
  const tmp = mkdtempSync(join(tmpdir(), "jarpeek-fixtures-"));
  try {
    const bigService = join(SRC, "com/example/BigService.java");
    writeFileSync(bigService, bigServiceSource());
    console.log(`generated ${relative(PKG_ROOT, bigService)} (${bigServiceSource().split("\n").length} lines)`);

    const logo = join(RESOURCES, "logo.png");
    writeFileSync(logo, LOGO_PNG);

    mkdirSync(OUT_DIR, { recursive: true });

    // demo-lib: compiled classes + resources, with the jar tool's manifest.
    const demoClasses = join(tmp, "demo-classes");
    const sources = listFiles(SRC);
    run("javac", ["-d", demoClasses, ...sources.map((f) => join(SRC, f))]);
    const demoJar = join(OUT_DIR, "demo-lib-1.0.0.jar");
    const demoArgs = createJar(demoJar);
    for (const f of listFiles(demoClasses)) demoArgs.push("-C", demoClasses, f);
    for (const f of listFiles(RESOURCES)) demoArgs.push("-C", RESOURCES, f);
    run("jar", demoArgs);
    summary("demo-lib", demoJar);

    // javap goldens for the class-file reader, from the same compiled classes
    mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const binaryName of DEMO_GOLDENS) writeJavapGolden(demoClasses, binaryName);

    // sources jar: the same .java files, nothing else.
    const sourcesJar = join(OUT_DIR, "demo-lib-1.0.0-sources.jar");
    const sourcesArgs = createJar(sourcesJar, { manifest: false });
    for (const f of sources) sourcesArgs.push("-C", SRC, f);
    run("jar", sourcesArgs);
    summary("sources", sourcesJar);

    // nosources jar: Hidden compiled alone; no sources jar is ever built for it.
    const hiddenClasses = join(tmp, "nosources-classes");
    const hiddenSources = listFiles(NOSOURCES_SRC);
    run("javac", ["-d", hiddenClasses, ...hiddenSources.map((f) => join(NOSOURCES_SRC, f))]);
    const nosourcesJar = join(OUT_DIR, "nosources-lib-1.0.0.jar");
    const nosourcesArgs = createJar(nosourcesJar, { manifest: false });
    for (const f of listFiles(hiddenClasses)) nosourcesArgs.push("-C", hiddenClasses, f);
    run("jar", nosourcesArgs);
    summary("nosources", nosourcesJar);
    writeJavapGolden(hiddenClasses, "com.example.nosources.Hidden");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
