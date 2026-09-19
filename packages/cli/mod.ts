#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

import { Command } from "@cliffy/command";
import { renderReport, type Report } from "@octosmith/core";
import type { ReconciliationRuntime } from "./reconcile.ts";
import { createGitHubRuntime, reconcile } from "./reconcile.ts";
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
        .arguments("[repository:string]")
        .option("-p, --path <path:string>", "Configuration directory.", {
          default: ".",
        })
        .action(async (commandOptions, repository?: string) => {
          const runtime = options.runtime ?? createDefaultRuntime();
          const report = await reconcile(runtime, {
            path: commandOptions.path,
            mode,
            ...(repository && { repository }),
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

function createDefaultRuntime(): ReconciliationRuntime {
  const token = Deno.env.get("GITHUB_TOKEN");

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is required to access GitHub",
    );
  }

  return createGitHubRuntime({ token });
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
