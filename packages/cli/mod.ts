#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

import { Command } from "@cliffy/command";
import cliMetadata from "./deno.json" with { type: "json" };

/** The OctoSmith CLI version. */
export const VERSION = cliMetadata.version;

const cli = new Command()
  .name("octosmith")
  .description("Declaratively reconcile GitHub repository configuration.")
  .version(VERSION)
  .versionOption("-v, --version", "Print the OctoSmith CLI version.")
  .noExit()
  .action(function () {
    this.showHelp();
  });

/** Return the CLI help text. */
export function usage(): string {
  return cli.getHelp();
}

/** Run the OctoSmith CLI. */
export async function main(args: string[]): Promise<number> {
  try {
    await cli.parse(args);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
