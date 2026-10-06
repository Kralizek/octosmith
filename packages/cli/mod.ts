#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run=gh

/**
 * Octosmith command-line host for validating, planning, and applying GitHub
 * repository configuration.
 *
 * @module
 */

import { Command } from "@cliffy/command";
import {
  type ConfigurationValidationIssue,
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
  validateConfigurationDirectoryDetailed,
  validateLoadedConfiguration,
} from "@octosmith/octosmith";
import { openEventOutput, toRepositoryEvent } from "./events.ts";
import { type GitHubTokenOptions, resolveGitHubToken } from "./auth.ts";
import { parseOutputFormat, renderOutput } from "./output.ts";
import {
  parsePermissionOutputFormat,
  renderPermissionsGithubOutput,
} from "./permissions_output.ts";
import type { ApplyRuntime } from "./apply.ts";
import { apply, createGitHubRuntime } from "./apply.ts";
import { resolveTemplateIdentity } from "./template.ts";
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
    const validation = await validateConfigurationDirectoryDetailed(
      commandOptions.path,
    );
    const result = validation.issues.length === 0
      ? { valid: true as const, diagnostics: validation.diagnostics }
      : {
        valid: false as const,
        diagnostics: validation.diagnostics,
        issues: validation.issues,
      };
    const rendered = renderOutput(
      format,
      result,
      (value) =>
        renderValidationResult(
          value.valid,
          value.diagnostics,
          value.valid ? [] : value.issues,
        ),
    );

    if (validation.issues.length > 0) {
      if (format === "json") {
        write(rendered);
      } else {
        writeError(rendered);
      }
      throw new ValidationFailedError();
    }

    write(rendered);
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
      .option(
        "--template <template:string>",
        "Limit operations to repositories classified with this template.",
      )
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
          readonly template?: string;
        };

        if (modeOptions.template === "") {
          throw new Error("Template filter must not be empty");
        }
        if (modeOptions.template !== undefined && resource !== undefined) {
          throw new Error(
            "Cannot combine a template filter with a repository target",
          );
        }
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
        const template = modeOptions.template === undefined
          ? undefined
          : resolveTemplateIdentity(loaded, modeOptions.template);
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
              const artifact = template === undefined ? persistedArtifact : {
                ...persistedArtifact,
                resources: persistedArtifact.resources.filter((resource) =>
                  resource.template.id === template
                ),
              };
              await applyPersistedPlan(
                runtime,
                loaded,
                artifact,
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
              ...(template !== undefined && { template }),
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
          .option(
            "--format <format:string>",
            "Output format: text, json, or github-output.",
            {
              default: "text",
            },
          )
          .action(async (commandOptions, template?: string) => {
            const format = parsePermissionOutputFormat(commandOptions.format);
            const loaded = await loadConfigurationDirectory(
              commandOptions.path,
              template,
            );
            await validateLoadedConfiguration(loaded, template);
            const requirements = requiredPermissionsForConfiguration(
              loaded,
              template,
            );
            if (format === "github-output") {
              const rendered = renderPermissionsGithubOutput(requirements);
              if (rendered.length > 0) write(rendered);
              return;
            }
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

class ValidationFailedError extends Error {
  constructor() {
    super("Configuration validation failed");
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
    if (
      error instanceof ApplyFailedError ||
      error instanceof ValidationFailedError
    ) {
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

function renderValidationResult(
  valid: boolean,
  diagnostics: readonly RuntimeReferenceDiagnostic[],
  issues: readonly ConfigurationValidationIssue[],
): string {
  const errors = issues.map((issue) =>
    "Error: " +
    (issue.template === undefined ? "" : "[" + issue.template + "] ") +
    issue.message
  );
  const warnings = renderValidationDiagnostics(diagnostics);

  return [
    valid ? "Configuration is valid." : "Configuration is invalid.",
    ...errors,
    ...warnings,
  ].join("\n\n");
}

function renderValidationDiagnostics(
  diagnostics: readonly RuntimeReferenceDiagnostic[],
): readonly string[] {
  const rendered: ValidationDiagnosticGroup[] = [];
  const groups = new Map<string, ValidationDiagnosticGroup>();

  for (const diagnostic of diagnostics) {
    const key = validationDiagnosticKey(diagnostic);
    let group = groups.get(key);

    if (group === undefined) {
      group = { diagnostics: [] };
      groups.set(key, group);
      rendered.push(group);
    }

    group.diagnostics.push(diagnostic);
  }

  return rendered.map((value) =>
    value.diagnostics.length === 1
      ? renderValidationDiagnostic(value.diagnostics[0])
      : renderGroupedRuntimeReferenceDiagnostic(value.diagnostics)
  );
}

function renderGroupedRuntimeReferenceDiagnostic(
  diagnostics: readonly RuntimeReferenceDiagnostic[],
): string {
  const references = diagnostics.map((diagnostic) => ({
    source: diagnostic.resource === undefined
      ? diagnostic.template
      : diagnostic.template + " / " + diagnostic.resource.type + ":" +
        diagnostic.resource.name,
    path: diagnostic.path,
  }));
  const sourceWidth = Math.max(
    ...references.map((reference) => reference.source.length),
  );

  return [
    renderValidationDiagnosticPrefix(diagnostics[0].severity) +
    describeRuntimeReferenceDiagnostic(diagnostics[0]),
    "",
    "Referenced by:",
    ...references.map((reference) =>
      "  " + reference.source.padEnd(sourceWidth) + "  " + reference.path
    ),
  ].join("\n");
}

function renderValidationDiagnostic(
  diagnostic: RuntimeReferenceDiagnostic,
): string {
  return renderValidationDiagnosticPrefix(diagnostic.severity) +
    renderRuntimeReferenceDiagnostic(diagnostic);
}

function renderValidationDiagnosticPrefix(
  severity: RuntimeReferenceDiagnostic["severity"],
): string {
  return severity === "error" ? "Error: " : "Warning: ";
}

function validationDiagnosticKey(
  diagnostic: Pick<RuntimeReferenceDiagnostic, "severity" | "code" | "name">,
): string {
  return `${diagnostic.severity}\0${diagnostic.code}\0${diagnostic.name}`;
}

interface ValidationDiagnosticGroup {
  readonly diagnostics: RuntimeReferenceDiagnostic[];
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
