#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

import { Command } from "@cliffy/command";
import { renderReport, type Report } from "@octosmith/core";
import type { ReconciliationRuntime } from "./reconcile.ts";
import { reconcile } from "./reconcile.ts";
import cliMetadata from "./deno.json" with { type: "json" };

/** The OctoSmith CLI version. */
export const VERSION = cliMetadata.version;

export interface CliExecutionOptions {
  readonly runtime?: ReconciliationRuntime;
  readonly write?: (value: string) => void;
}

function createCli(options: CliExecutionOptions = {}): Command {
  const write = options.write ?? console.log;

  const root = new Command()
    .name("octosmith")
    .description("Declaratively reconcile GitHub repository configuration.")
    .version(VERSION)
    .versionOption("-v, --version", "Print the OctoSmith CLI version.")
    .noExit()
    .action(function () {
      this.showHelp();
    });

  for (const mode of ["plan", "apply"] as const) {
    root.command(
      mode,
      new Command()
        .description(
          mode === "plan"
            ? "Show repository configuration changes."
            : "Apply repository configuration changes.",
        )
        .option("-p, --path <path:string>", "Configuration directory.", {
          default: ".",
        })
        .option(
          "--collections <mode:string>",
          "Collection reconciliation mode: sparse or strict.",
          { default: "sparse" },
        )
        .action(async (commandOptions) => {
          if (!options.runtime) {
            throw new Error(
              "GitHub runtime is not configured for " + mode + " execution",
            );
          }

          if (
            commandOptions.collections !== "sparse" &&
            commandOptions.collections !== "strict"
          ) {
            throw new Error(
              "Invalid collection mode: " + commandOptions.collections,
            );
          }

          const report = await reconcile(options.runtime, {
            path: commandOptions.path,
            mode,
            collections: commandOptions.collections,
          });

          write(renderReport(report));

          if (hasFailures(report)) {
            throw new ReconciliationFailedError();
          }
        }),
    );
  }

  return root;
}

class ReconciliationFailedError extends Error {
  constructor() {
    super("Reconciliation completed with failures");
  }
}

function hasFailures(report: Report): boolean {
  return report.repositories.some((repository) =>
    repository.status === "failed" ||
    repository.status === "partially-applied"
  );
}

/** Return the CLI help text. */
export function usage(): string {
  return createCli().getHelp();
}

/** Run the OctoSmith CLI. */
export async function main(
  args: string[],
  options: CliExecutionOptions = {},
): Promise<number> {
  try {
    await createCli(options).parse(args);
    return 0;
  } catch (error) {
    if (error instanceof ReconciliationFailedError) {
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${message}`);
    return 1;
  }
}

export * from "./reconcile.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
