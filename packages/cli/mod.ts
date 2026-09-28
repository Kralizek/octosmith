#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run=gh

/**
 * Octosmith command-line host for validating, planning, and applying GitHub
 * repository configuration.
 *
 * @module
 */

import { Command } from "@cliffy/command";
import {
  createPersistedPlanArtifact,
  describeRuntimeReferenceDiagnostic,
  getGitHubPermissionDescriptor,
  type GitHubPermissionRequirement,
  inspectResource,
  loadConfigurationDirectory,
  parsePersistedPlanArtifact,
  renderReport,
  renderResourceInspection,
  renderRuntimeReferenceDiagnostic,
  type Report,
  type RepositoryReport,
  requiredPermissionsForConfiguration,
  type ResourceInspection,
  type RuntimeReferenceDiagnostic,
  summarizeResourceInspection,
  validateConfigurationDirectory,
  validateLoadedConfiguration,
} from "@octosmith/octosmith";
import { openEventOutput, toRepositoryEvent } from "./events.ts";
import { type GitHubTokenOptions, resolveGitHubToken } from "./auth.ts";
import { parseOutputFormat, renderOutput } from "./output.ts";
import type { ApplyRuntime } from "./apply.ts";
import { apply, createGitHubRuntime } from "./apply.ts";
import {
  applyPersistedPlan,
  PersistedPlanStaleError,
  renderPersistedPlanPreflight,
} from "./persisted.ts";
import cliMetadata from "./deno.json" with { type: "json" };

/** The Octosmith CLI version. */
export const VERSION = cliMetadata.version;

/** Describes cli execution options. */
export interface CliExecutionOptions {
  readonly runtime?: ApplyRuntime;
  readonly credentials?: GitHubTokenOptions;
  readonly fetch?: typeof globalThis.fetch;
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
    const diagnostics = await validateConfigurationDirectory(
      commandOptions.path,
    );
    const result = { valid: true, diagnostics };
    write(
      renderOutput(
        format,
        result,
        (value) => {
          const warnings = renderValidationWarnings(value.diagnostics);
          return ["Configuration is valid.", ...warnings].join("\n\n");
        },
      ),
    );
  };

  const root = new Command()
    .name("octosmith")
    .description("Declaratively manage GitHub resources.")
    .version(VERSION)
    .versionOption("--version", "Print the Octosmith CLI version.", {
      global: true,
    })
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
        const modeOptions = commandOptions as typeof commandOptions & {
          readonly plan?: string;
          readonly out?: string;
        };

        if (
          mode === "apply" &&
          modeOptions.plan !== undefined &&
          resource !== undefined
        ) {
          throw new Error(
            "Cannot combine a resource target with --plan",
          );
        }

        if (mode === "plan" && modeOptions.out === "") {
          throw new Error("Persisted plan output path must not be empty");
        }
        if (mode === "apply" && modeOptions.plan === "") {
          throw new Error("Persisted plan path must not be empty");
        }

        const format = parseOutputFormat(commandOptions.format);
        const runtime = options.runtime ??
          await createDefaultRuntime(
            commandOptions.trace ?? false,
            writeError,
            options.credentials,
            options.fetch,
          );
        const loaded = await loadConfigurationDirectory(
          commandOptions.path,
        );
        if (
          commandOptions.eventsOutput !== undefined &&
          commandOptions.eventsOutput.length === 0
        ) {
          throw new Error("Events output path must not be empty");
        }

        const persistedArtifact =
          mode === "apply" && modeOptions.plan !== undefined
            ? parsePersistedPlanArtifact(
              JSON.parse(await Deno.readTextFile(modeOptions.plan)),
            )
            : undefined;

        const eventOutput = commandOptions.eventsOutput !== undefined
          ? await openEventOutput(commandOptions.eventsOutput)
          : undefined;
        const startedAt = new Date();
        const repositories: RepositoryReport[] = [];
        const inspectedResources: ResourceInspection[] = [];
        const persistedResources:
          import("@octosmith/octosmith").PersistedResourceInput[] = [];

        const onRepositoryApplied = async (
          repositoryReport: RepositoryReport,
        ) => {
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
        };

        try {
          if (mode === "apply" && persistedArtifact !== undefined) {
            try {
              await applyPersistedPlan(
                runtime,
                loaded,
                persistedArtifact,
                onRepositoryApplied,
              );
            } catch (error) {
              if (error instanceof PersistedPlanStaleError) {
                write(
                  renderOutput(
                    format,
                    error.preflight,
                    renderPersistedPlanPreflight,
                  ),
                );
                throw new ApplyFailedError();
              }
              throw error;
            }
          } else {
            await apply(runtime, loaded, {
              mode,
              ...(resource !== undefined && { resource }),
              onRepositoryApplied,
              onResourceInspected: (resource) =>
                inspectedResources.push(resource),
              ...(mode === "plan" && modeOptions.out !== undefined && {
                onPlanBuilt: (plannedResource) => {
                  persistedResources.push(plannedResource);
                },
              }),
            });
          }
        } finally {
          eventOutput?.close();
        }

        const report: Report = {
          organization: loaded.configuration.organization,
          startedAt,
          completedAt: new Date(),
          repositories,
          ...(persistedArtifact === undefined && {
            inspection: summarizeResourceInspection(inspectedResources),
          }),
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

        if (mode === "plan" && modeOptions.out !== undefined) {
          const artifact = await createPersistedPlanArtifact(
            loaded,
            persistedResources,
          );
          await Deno.writeTextFile(
            modeOptions.out,
            JSON.stringify(artifact, null, 2) + "\n",
          );
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
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: text or json.", {
            default: "text",
          })
          .option("--trace", "Emit GitHub API request traces to stderr.")
          .action(async (commandOptions) => {
            const format = parseOutputFormat(commandOptions.format);
            const runtime = options.runtime ??
              await createDefaultRuntime(
                commandOptions.trace ?? false,
                writeError,
                options.credentials,
                options.fetch,
              );
            const loaded = await loadConfigurationDirectory(
              commandOptions.path,
            );
            const discovery = await runtime.discover(loaded);
            const result = summarizeResourceInspection(
              discovery.repositories.map((resource) =>
                inspectResource(loaded, resource)
              ),
            );
            write(renderOutput(format, result, renderResourceInspection));

            for (const failure of discovery.failures) {
              const message = failure.error instanceof Error
                ? failure.error.message
                : String(failure.error);
              writeError(
                "[ERROR] Resource " + failure.repository + ": " + message,
              );
            }
            if (
              result.summary.unmatched > 0 &&
              loaded.configuration.repositories.settings
                  ?.unmatchedRepositories !== "ignore"
            ) {
              writeError(
                "[ERROR] " + result.summary.unmatched +
                  " resources in the configuration scope did not match a template.",
              );
              throw new ApplyFailedError();
            }
            if (discovery.failures.length > 0) {
              throw new ApplyFailedError();
            }
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
          .action(async (commandOptions, template?: string) => {
            const format = parseOutputFormat(commandOptions.format);
            const loaded = await loadConfigurationDirectory(
              commandOptions.path,
              template,
            );
            await validateLoadedConfiguration(loaded, template);
            const requirements = requiredPermissionsForConfiguration(
              loaded,
              template,
            );
            write(renderOutput(
              format,
              { requirements },
              ({ requirements }) => renderPermissionRequirements(requirements),
            ));
          }),
      ),
  );

  return root;
}

function renderPermissionRequirements(
  requirements: readonly GitHubPermissionRequirement[],
): string {
  if (requirements.length === 0) return "No permissions required.";

  return (["repository", "organization"] as const).flatMap((scope) => {
    const entries = requirements.filter((item) => item.scope === scope);
    return entries.length === 0 ? [] : [
      `${scope === "repository" ? "Repository" : "Organization"} permissions:`,
      ...entries.map((item) =>
        `  ${
          getGitHubPermissionDescriptor(item).displayName
        } (${item.permission}): ${item.access}`
      ),
    ];
  }).join("\n");
}

async function createDefaultRuntime(
  trace: boolean,
  writeError: (value: string) => void,
  credentials?: GitHubTokenOptions,
  fetch?: typeof globalThis.fetch,
): Promise<ApplyRuntime> {
  const token = await resolveGitHubToken(credentials);

  let firstTraceGroup = true;

  return createGitHubRuntime({
    token,
    fetch,
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
    (options.writeError ?? console.error)(`[ERROR] ${message}`);
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

function renderValidationWarnings(
  diagnostics: readonly RuntimeReferenceDiagnostic[],
): readonly string[] {
  const rendered: Array<
    | { kind: "warning"; text: string }
    | { kind: "group"; group: ValidationWarningGroup }
  > = [];
  const unresolvedSecretGroups = new Map<
    string,
    ValidationWarningGroup
  >();

  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "unresolved_secret") {
      rendered.push({
        kind: "warning",
        text: "Warning: " + renderRuntimeReferenceDiagnostic(diagnostic),
      });
      continue;
    }

    const key =
      `${diagnostic.severity}\0${diagnostic.code}\0${diagnostic.name}`;
    let group = unresolvedSecretGroups.get(key);

    if (group === undefined) {
      group = {
        severity: diagnostic.severity,
        code: diagnostic.code,
        name: diagnostic.name,
        references: [],
      };
      unresolvedSecretGroups.set(key, group);
      rendered.push({ kind: "group", group });
    }

    group.references.push({
      template: diagnostic.template,
      path: diagnostic.path,
    });
  }

  return rendered.map((value) =>
    value.kind === "warning"
      ? value.text
      : "Warning: " + renderGroupedRuntimeReferenceDiagnostic(value.group)
  );
}

function renderGroupedRuntimeReferenceDiagnostic(
  diagnostic: ValidationWarningGroup,
): string {
  const templateWidth = Math.max(
    0,
    ...diagnostic.references.map(({ template }) => template.length),
  );
  const references = diagnostic.references.map(({ template, path }) =>
    `  ${template.padEnd(templateWidth)}  ${path}`
  );

  return [
    describeRuntimeReferenceDiagnostic(diagnostic),
    "",
    "Referenced by:",
    ...references,
  ].join("\n");
}

interface ValidationWarningGroup {
  readonly severity: RuntimeReferenceDiagnostic["severity"];
  readonly code: RuntimeReferenceDiagnostic["code"];
  readonly name: string;
  readonly references: Array<{ template: string; path: string }>;
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
export * from "./persisted.ts";

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
