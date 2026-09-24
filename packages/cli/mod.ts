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
  const executeValidation = async (
    commandOptions: { path: string; format: string },
    template?: string,
  ) => {
    if (template !== undefined) {
      throw new Error("Template-specific validation is not implemented yet");
    }

    const format = parseOutputFormat(commandOptions.format);
    await validateConfigurationDirectory(commandOptions.path);
    write(
      renderOutput(
        format,
        { valid: true },
        () => "Configuration is valid.",
      ),
    );
  };

  const root = new Command()
    .name("octosmith")
    .description("Declaratively manage GitHub resources.")
    .version(VERSION)
    .versionOption("--version", "Print the Octosmith CLI version.")
    .noExit()
    .action(function () {
      this.showHelp();
    });

  for (const mode of ["plan", "apply"] as const) {
    const command = new Command()
      .description(
        mode === "plan" ? "Show required changes." : "Apply required changes.",
      )
      .arguments("[resource:string]")
      .option("-p, --path <path:string>", "Configuration directory.", {
        default: ".",
      })
      .option("--format <format:string>", "Output format: text or json.", {
        default: "text",
      })
      .option("-v, --verbose", "Show additional result details.")
      .option("--trace", "Emit GitHub API request traces to stderr.")
      .option(
        "--events-output <path:string>",
        "Write Hooksmith resource events as NDJSON.",
      );

    if (mode === "plan") {
      command.option(
        "--out <path:string>",
        "Write the persisted plan artifact.",
      );
    } else {
      command.option(
        "--plan <path:string>",
        "Apply a persisted plan artifact.",
      );
    }

    root.command(
      mode,
      command.action(async (commandOptions, resource?: string) => {
        assertResourcePosition(args, mode, resource);

        if (mode === "apply" && commandOptions.plan !== undefined) {
          if (resource !== undefined) {
            throw new Error(
              "Cannot combine a resource target with --plan",
            );
          }

          throw new Error("Persisted plan apply is not implemented yet");
        }

        if (mode === "plan" && commandOptions.out !== undefined) {
          throw new Error("Persisted plan output is not implemented yet");
        }

        const format = parseOutputFormat(commandOptions.format);
        const runtime = options.runtime ??
          createDefaultRuntime(commandOptions.trace ?? false, writeError);
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
            ...(resource !== undefined && { resource }),
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
              renderReport(value, {
                verbose: commandOptions.verbose,
              }),
          ),
        );

        if (hasFailures(report)) {
          throw new ApplyFailedError();
        }
      }),
    );
  }

  root.command(
    "resource",
    new Command()
      .description("Resource operations.")
      .command(
        "list",
        new Command()
          .description("List resources within configured scope.")
          .action(() => {
            throw new Error("resource list is not implemented yet");
          }),
      )
      .command(
        "create",
        new Command()
          .description("Create a resource from a template.")
          .arguments("<template:string>")
          .option("--name <name:string>", "Name for the new resource.")
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: text or json.", {
            default: "text",
          })
          .action((_commandOptions, _template: string) => {
            throw new Error("resource create is not implemented yet");
          }),
      ),
  );

  root.command(
    "template",
    new Command()
      .description("Template operations.")
      .command(
        "validate",
        new Command()
          .description(
            "Validate configuration and templates without accessing GitHub.",
          )
          .arguments("[template:string]")
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: text or json.", {
            default: "text",
          })
          .action(executeValidation),
      )
      .command(
        "permissions",
        new Command()
          .description(
            "Analyze worst-case permissions for the selected template or configuration.",
          )
          .arguments("[template:string]")
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: text or json.", {
            default: "text",
          })
          .action((_commandOptions, _template?: string) => {
            throw new Error("template permissions is not implemented yet");
          }),
      ),
  );

  return root;
}

function createDefaultRuntime(
  trace: boolean,
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
    ...(trace && {
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
    validateRawResourceArgument(args);
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

function validateRawResourceArgument(args: readonly string[]): void {
  const [command, ...rest] = args;

  if (command !== "plan" && command !== "apply") {
    return;
  }

  if (rest.includes("")) {
    throw new Error("Resource target must not be empty");
  }
}

function assertResourcePosition(
  args: readonly string[] | undefined,
  command: "plan" | "apply",
  resource: string | undefined,
): void {
  if (resource === undefined || args === undefined) {
    return;
  }

  if (args[0] !== command || args[1] !== resource) {
    throw new Error(
      "Resource target must appear immediately after the command",
    );
  }
}

export * from "./events.ts";
export * from "./output.ts";
export * from "./apply.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
