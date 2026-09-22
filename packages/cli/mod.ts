#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net

/**
 * Octosmith command-line host for validating, planning, and applying GitHub
 * repository configuration.
 *
 * @module
 */

import { Command } from "@cliffy/command";
import {
  loadConfigurationDirectory,
  renderReport,
  type Report,
  type RepositoryReport,
  validateConfigurationDirectory,
} from "@octosmith/octosmith";
import { openEventOutput, toRepositoryEvent } from "./events.ts";
import { parseOutputFormat, renderOutput } from "./output.ts";
import type { ApplyRuntime } from "./apply.ts";
import { apply, createGitHubRuntime } from "./apply.ts";
import cliMetadata from "./deno.json" with { type: "json" };

/** The Octosmith CLI version. */
export const VERSION = cliMetadata.version;

/** Describes cli execution options. */
export interface CliExecutionOptions {
  readonly runtime?: ApplyRuntime;
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
    .description("Declaratively apply GitHub repository configuration.")
    .version(VERSION)
    .versionOption("-v, --version", "Print the Octosmith CLI version.")
    .noExit()
    .action(function () {
      this.showHelp();
    });

  root.command(
    "validate",
    new Command()
      .description("Validate configuration without accessing GitHub.")
      .option("-p, --path <path:string>", "Configuration directory.", {
        default: ".",
      })
      .option("--format <format:string>", "Output format: text or json.", {
        default: "text",
      })
      .action(async (commandOptions) => {
        const format = parseOutputFormat(commandOptions.format);
        await validateConfigurationDirectory(commandOptions.path);
        write(
          renderOutput(
            format,
            { valid: true },
            () => "Configuration is valid.",
          ),
        );
      }),
  );

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
        .option("--verbose", "Show unchanged apply items.")
        .option(
          "--events-output <path:string>",
          "Write Hooksmith repository events as NDJSON.",
        )
        .action(async (commandOptions, repository?: string) => {
          assertRepositoryPosition(args, mode, repository);
          const format = parseOutputFormat(commandOptions.format);
          const runtime = options.runtime ??
            createDefaultRuntime(commandOptions.verbose ?? false, writeError);
          const loaded = await loadConfigurationDirectory(
            commandOptions.path,
          );
          if (
            commandOptions.eventsOutput !== undefined &&
            commandOptions.eventsOutput.length === 0
          ) {
            throw new Error("Events output path must not be empty");
          }

          const eventOutput = commandOptions.eventsOutput !== undefined
            ? await openEventOutput(commandOptions.eventsOutput)
            : undefined;
          const startedAt = new Date();
          const repositories: RepositoryReport[] = [];

          try {
            await apply(runtime, loaded, {
              mode,
              ...(repository !== undefined && { repository }),
              onRepositoryApplied: async (repositoryReport) => {
                repositories.push(repositoryReport);

                if (eventOutput) {
                  await eventOutput.write(
                    toRepositoryEvent(
                      loaded.configuration.organization,
                      mode,
                      repositoryReport,
                    ),
                  );
                }
              },
            });
          } finally {
            eventOutput?.close();
          }

          const report: Report = {
            organization: loaded.configuration.organization,
            startedAt,
            completedAt: new Date(),
            repositories,
          };

          write(
            renderOutput(
              format,
              report,
              (value) =>
                renderReport(value, { verbose: commandOptions.verbose }),
            ),
          );

          if (hasFailures(report)) {
            throw new ApplyFailedError();
          }
        }),
    );
  }

  return root;
}

function createDefaultRuntime(
  verbose: boolean,
  writeError: (value: string) => void,
): ApplyRuntime {
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

class ApplyFailedError extends Error {
  constructor() {
    super("Apply completed with failures");
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

/** Run the Octosmith CLI. */
export async function main(
  args: string[],
  options: CliExecutionOptions = {},
): Promise<number> {
  try {
    validateRawEventsOutputArgument(args);
    validateRawRepositoryArgument(args);
    await createCli(options, args).parse(args);
    return 0;
  } catch (error) {
    if (error instanceof ApplyFailedError) {
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${message}`);
    return 1;
  }
}

function validateRawEventsOutputArgument(args: readonly string[]): void {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--events-output" && args[index + 1] === "") {
      throw new Error("Events output path must not be empty");
    }

    if (args[index] === "--events-output=") {
      throw new Error("Events output path must not be empty");
    }
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

export * from "./events.ts";
export * from "./output.ts";
export * from "./apply.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
