#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { VERSION } from "../version.js";

function notImplemented(): never {
  throw new InvalidArgumentError("not implemented");
}

const program = new Command();

program
  .name("jarpeek")
  .description("Dependency source access for AI agents on JVM projects")
  .version(VERSION);

const stubCommands = [
  "init",
  "prime",
  "mcp",
  "find-class",
  "outline",
  "read-member",
  "read-source",
  "read-resource",
  "search-symbols",
  "resolve",
  "status",
  "where",
] as const;

for (const name of stubCommands) {
  program
    .command(name)
    .argument("[args...]")
    .allowExcessArguments()
    .action(notImplemented);
}

program.action(() => {
  program.help();
});

program.parse();
