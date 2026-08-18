import { readFileSync } from "node:fs";

/** Single source of truth is package.json — `npm version` bumps only that file. */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
