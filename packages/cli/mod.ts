#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

import { Command } from "@cliffy/command";
import { renderReport, type Report } from "@octosmith/core";
import { parseOutputFormat, renderOutput } from "./output.ts";
import type { ReconciliationRuntime } from "./reconcile.ts";
import { createGitHubRuntime, reconcile } from "./reconcile.ts";
import cliMetadata from "./deno.json" with { type: "json" };

/** The OctoSmith CLI version. */
export const VERSION = cliMetadata.version;

export interface CliExecutionOptions {
  readonly runtime?: ReconciliationRuntime;
  readonly write?: (value: string) => void;
  readonly writeError?: (value: string) => void;
}

function createCli(
  options: CliExecutionOptions = {},
  args?: readonly string[],
): Command {
  const write = options.write ?? console.log;
  const writeError = options.writeError ?? console.error;

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
        .option("--format <format:string>", "Output format: text or json.", {
          default: "text",
        })
        .option("--verbose", "Show unchanged reconciliation items.")
        .action(async (commandOptions, repository?: string) => {
          assertRepositoryPosition(args, mode, repository);
          const format = parseOutputFormat(commandOptions.format);
          const runtime = options.runtime ??
            createDefaultRuntime(commandOptions.verbose ?? false, writeError);
          const report = await reconcile(runtime, {
            path: commandOptions.path,
            mode,
            ...(repository !== undefined && { repository }),
          });

          write(
            renderOutput(
              format,
              report,
              (value) =>
                renderReport(value, { verbose: commandOptions.verbose }),
            ),
          );

          if (hasFailures(report)) {
            throw new ReconciliationFailedError();
          }
        }),
    );
  }

  return root;
}

function createDefaultRuntime(
  verbose: boolean,
  writeError: (value: string) => void,
): ReconciliationRuntime {
  const token = Deno.env.get("GITHUB_TOKEN");

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is required to access GitHub",
    );
  }

  let firstTraceGroup = true;

  return createGitHubRuntime({
    token,
    ...(verbose && {
      traceGroup: (name) => {
        if (!firstTraceGroup) {
          writeError("");
        }

        firstTraceGroup = false;
        writeError("[" + name + "]");
      },
      trace: ({ method, path, status }) =>
        writeError(method + " " + path + " — " + status),
    }),
  });
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
    validateRawRepositoryArgument(args);
    await createCli(options, args).parse(args);
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

function validateRawRepositoryArgument(args: readonly string[]): void {
  const [command, ...rest] = args;

  if (command !== "plan" && command !== "apply") {
    return;
  }

  if (rest.includes("")) {
    throw new Error("Repository target must not be empty");
  }
}

function assertRepositoryPosition(
  args: readonly string[] | undefined,
  command: "plan" | "apply",
  repository: string | undefined,
): void {
  if (repository === undefined || args === undefined) {
    return;
  }

  if (args[0] !== command || args[1] !== repository) {
    throw new Error(
      "Repository target must appear immediately after the command",
    );
  }
}

export * from "./output.ts";
export * from "./reconcile.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
