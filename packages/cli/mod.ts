#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run=gh,git

/**
 * Command-line host for validating, inspecting, planning, and applying GitHub
 * repository configuration.
 *
 * Install with `deno install -A -n octosmith jsr:@octosmith/cli@0`.
 * For commands, credentials, and output formats, see the
 * [CLI reference](https://github.com/Kralizek/octosmith/blob/master/docs/cli/README.md).
 *
 * @module
 */

import { Command } from "@cliffy/command";
import { stringify } from "@std/yaml";
import {
  buildRepositoryCreationPreview,
  type ConfigurationValidationIssue,
  createPersistedPlanArtifact,
  createRepository,
  describeRuntimeReferenceDiagnostic,
  getGitHubPermissionDescriptor,
  type GitHubPermissionRequirement,
  inspectResource,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  parsePersistedPlanArtifact,
  preflightRepositoryCreation,
  renderReport,
  renderRepositoryCreationPreview,
  renderRepositoryCreationResult,
  renderResourceInspection,
  renderRuntimeReferenceDiagnostic,
  type Report,
  type RepositoryReport,
  requiredPermissionsForConfiguration,
  requiredPermissionsForRepositoryCreation,
  type ResourceInspection,
  type RuntimeReferenceDiagnostic,
  summarizeResourceInspection,
  toSchemaCompatibleRepositoryTemplate,
  validateConfigurationDirectoryDetailed,
  validateLoadedConfiguration,
  validateTemplateDirectoryDetailed,
} from "@octosmith/octosmith";
import {
  openEventOutput,
  toPullRequestEvent,
  toRepositoryEvent,
} from "./events.ts";
import {
  type PullRequestResult,
  uniquePullRequests,
} from "@octosmith/octosmith";
import { type GitHubTokenOptions, resolveGitHubToken } from "./auth.ts";
import { parseOutputFormat, renderOutput } from "./output.ts";
import {
  parsePermissionOutputFormat,
  renderPermissionsGithubOutput,
} from "./permissions_output.ts";
import type { ApplyRuntime } from "./apply.ts";
import { apply, createGitHubRuntime, environmentValue } from "./apply.ts";
import { resolveTemplateIdentity } from "./template.ts";
import {
  applyPersistedPlan,
  PersistedPlanStaleError,
  renderPersistedPlanPreflight,
} from "./persisted.ts";
import cliMetadata from "./deno.json" with { type: "json" };
import {
  type CreationPromptAdapter,
  resolveAssistedRepositoryCreation,
  terminalCreationPrompts,
} from "./assisted.ts";

/** The Octosmith CLI version. */
export const VERSION = cliMetadata.version;

/** Describes cli execution options. */
export interface CliExecutionOptions {
  readonly runtime?: ApplyRuntime;
  readonly bootstrap?: import("@octosmith/octosmith").RepositoryGitBootstrap;
  readonly credentials?: GitHubTokenOptions;
  readonly fetch?: typeof globalThis.fetch;
  readonly write?: (value: string) => void;
  readonly writeError?: (value: string) => void;
  readonly creationPrompts?: CreationPromptAdapter;
  /** Separate terminal capability dependency; prompts never imply a TTY. */
  readonly isInteractiveTerminal?: () => boolean;
}

function createCli(
  options: CliExecutionOptions = {},
  args?: readonly string[],
): Command {
  const write = options.write ?? console.log;
  const writeError = options.writeError ?? console.error;
  const executeValidation = async (
    commandOptions: { path: string; format: string; quiet?: boolean },
    template?: string,
  ) => {
    if (commandOptions.quiet && commandOptions.format === "json") {
      throw new Error("Cannot combine --quiet with --format json");
    }

    const format = parseOutputFormat(commandOptions.format);
    const validation = template === undefined
      ? await validateConfigurationDirectoryDetailed(
        commandOptions.path,
        environmentHas,
      )
      : await validateTemplateDirectoryDetailed(
        commandOptions.path,
        template,
        environmentHas,
      );
    const result = {
      valid: validation.issues.length === 0,
      diagnostics: validation.diagnostics,
      issues: validation.issues,
      intersections: validation.intersections,
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
        if (!commandOptions.quiet) {
          write(rendered);
        }
      } else {
        writeError(rendered);
      }
      throw new ValidationFailedError();
    }

    if (!commandOptions.quiet) {
      write(rendered);
    }
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
      .type("secret-boolean", ({ value }) => {
        return parseSecretBoolean(value);
      })
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
      .option("--quiet", "Suppress normal output.")
      .option("-v, --verbose", "Show additional result details.")
      .option("--trace", "Emit GitHub API request traces to stderr.")
      .option(
        "--include-secrets [value:secret-boolean]",
        "Include secrets in fresh reconciliation; false honors configuration (ignored with --plan).",
      )
      .option(
        "--skip-missing-values",
        "Skip unavailable runtime values when creating a fresh plan (not with --plan).",
      )
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
        if (args?.includes("--include-secrets=")) {
          throw new Error(
            "--include-secrets requires a boolean value: true or false.",
          );
        }
        assertResourcePosition(args, mode, resource);
        const modeOptions = commandOptions as typeof commandOptions & {
          readonly plan?: string;
          readonly out?: string;
          readonly template?: string;
          readonly skipMissingValues?: boolean;
          readonly includeSecrets?: boolean;
          readonly quiet?: boolean;
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
        if (modeOptions.plan !== undefined && modeOptions.skipMissingValues) {
          throw new Error(
            "Cannot combine --skip-missing-values with --plan. " +
              "Create a new plan with --skip-missing-values instead.",
          );
        }

        if (commandOptions.quiet && commandOptions.format === "json") {
          throw new Error("Cannot combine --quiet with --format json");
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

        const onPullRequest = async (result: PullRequestResult) => {
          if (eventOutput) {
            await eventOutput.write(
              toPullRequestEvent(loaded.configuration.organization, result),
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
              } as typeof persistedArtifact;
              await applyPersistedPlan(
                runtime,
                loaded,
                artifact,
                onRepositoryApplied,
                {
                  skipMissingValues: modeOptions.skipMissingValues,
                  onPullRequest,
                },
              );
            } catch (error) {
              if (error instanceof PersistedPlanStaleError) {
                const rendered = renderOutput(
                  format,
                  error.preflight,
                  renderPersistedPlanPreflight,
                );
                (commandOptions.quiet ? writeError : write)(rendered);
                throw new ApplyFailedError();
              }
              throw error;
            }
          } else {
            await apply(runtime, loaded, {
              mode,
              ...(resource !== undefined && { resource }),
              ...(template !== undefined && { template }),
              skipMissingValues: modeOptions.skipMissingValues,
              includeSecrets: modeOptions.includeSecrets,
              onRepositoryApplied,
              onPullRequest,
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

        const pullRequests = uniquePullRequests(
          repositories.flatMap((repository) => repository.pullRequests ?? []),
        );
        const reportedRepositories = repositories.map(({
          pullRequests: _pullRequests,
          ...repository
        }) => repository);
        const report: Report = {
          organization: loaded.configuration.organization,
          startedAt,
          completedAt: new Date(),
          repositories: reportedRepositories,
          mode,
          unmatchedPolicy: loaded.configuration.repositories.settings
            ?.unmatchedRepositories ?? "error",
          ...(mode === "apply" && { pullRequests }),
          ...(persistedArtifact === undefined && {
            inspection: summarizeResourceInspection(inspectedResources),
          }),
        };

        const renderedReport = renderOutput(
          format,
          report,
          (value) =>
            renderReport(value, {
              verbose: commandOptions.verbose,
            }),
        );
        const failed = hasFailures(report);
        if (commandOptions.quiet) {
          if (failed) {
            writeError(
              mode === "plan" && modeOptions.out !== undefined
                ? "Error: Plan contains failed resources; no plan file was written."
                : renderedReport,
            );
          }
        } else {
          write(renderedReport);
        }

        if (failed) {
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
          .type("secret-boolean", ({ value }) => parseSecretBoolean(value))
          .description(
            "Create an empty GitHub repository and reconcile API resources; --dry-run is read-only.",
          )
          .arguments("<template:string>")
          .option("--name <name:string>", "Name for the new resource.")
          .option(
            "--visibility <visibility:string>",
            "Visibility: public, private, or internal.",
          )
          .option(
            "--assisted",
            "Resolve ambiguous names and visibility interactively (TTY required; not with --dry-run or JSON).",
          )
          .option(
            "--dry-run",
            "Preview resolved creation and bootstrap intent offline.",
          )
          .option(
            "--include-secrets [value:secret-boolean]",
            "Include secrets; false honors configuration.",
          )
          .option(
            "--skip-missing-values",
            "Skip unavailable runtime values during reconciliation.",
          )
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: text or json.", {
            default: "text",
          })
          .action(async (commandOptions, template: string) => {
            const format = parseOutputFormat(commandOptions.format);
            if (commandOptions.assisted) {
              if (format === "json") {
                throw new Error("Cannot combine --assisted with --format json");
              }
              if (commandOptions.dryRun) {
                throw new Error("Cannot combine --assisted with --dry-run");
              }
              if (
                !(options.isInteractiveTerminal ??
                  (() => Deno.stdin.isTerminal() && Deno.stderr.isTerminal()))()
              ) {
                throw new Error(
                  "--assisted requires an interactive TTY (stdin and stderr)",
                );
              }
            }
            let input = {
              template,
              ...(commandOptions.name !== undefined && {
                name: commandOptions.name,
              }),
              ...(commandOptions.visibility !== undefined && {
                visibility: commandOptions.visibility,
              }),
            };
            if (!commandOptions.dryRun) {
              let configuration: LoadedConfiguration | string =
                commandOptions.path;
              if (commandOptions.assisted) {
                try {
                  configuration = await loadConfigurationDirectory(
                    commandOptions.path,
                  );
                } catch {
                  // Configuration parser errors can contain sensitive source snippets.
                  throw new Error(
                    "Cannot load configuration. Check the directory, YAML syntax, schema, and fragment includes with template validate.",
                  );
                }
                const specification = await resolveAssistedRepositoryCreation(
                  configuration,
                  input,
                  options.creationPrompts ?? terminalCreationPrompts,
                  writeError,
                );
                if (!specification.ready || !specification.repository) {
                  writeError(renderRepositoryCreationPreview(
                    buildRepositoryCreationPreview(
                      configuration,
                      specification,
                    ),
                  ));
                  throw new ApplyFailedError();
                }
                // Freeze the resolved identity; creation revalidates without regenerating.
                input = {
                  template,
                  name: specification.repository.name,
                  visibility: specification.repository.visibility,
                };
              }
              let creationRuntime: ApplyRuntime | undefined;
              const result = await createRepository(
                {
                  ...input,
                  configuration,
                  includeSecrets: commandOptions.includeSecrets,
                  skipMissingValues: commandOptions.skipMissingValues,
                },
                {
                  client: async () => {
                    const runtime = options.runtime ??
                      await createDefaultRuntime(
                        false,
                        writeError,
                        options.credentials,
                        options.fetch,
                      );
                    creationRuntime = runtime;
                    if (!runtime.client) {
                      throw new Error(
                        "Creation requires a GitHub client in the injected runtime",
                      );
                    }
                    if (!(options.bootstrap ?? runtime.bootstrap)) {
                      throw new Error(
                        "Creation requires an authenticated Git bootstrap transport",
                      );
                    }
                    return runtime.client;
                  },
                  values: options.runtime?.value ?? environmentValue,
                  bootstrap: {
                    bootstrap: (request) => {
                      const transport = options.bootstrap ??
                        creationRuntime?.bootstrap;
                      if (!transport) {
                        throw new Error(
                          "Creation requires an authenticated Git bootstrap transport",
                        );
                      }
                      return transport.bootstrap(request);
                    },
                  },
                },
              );
              const success = result.status === "completed";
              const rendered = renderOutput(
                format,
                result,
                renderRepositoryCreationResult,
              );
              if (format === "json" || success) write(rendered);
              else writeError(rendered);
              if (!success) throw new ApplyFailedError();
              return;
            }
            let loaded: LoadedConfiguration;
            try {
              loaded = await loadConfigurationDirectory(commandOptions.path);
            } catch {
              const failure = {
                kind: "repository_creation_configuration_error",
                version: 1,
                ready: false,
                diagnostics: [{
                  code: "configuration_load_error",
                  message:
                    "Cannot load configuration. Check the directory, YAML syntax, schema, and fragment includes with template validate.",
                }],
              };
              const rendered = renderOutput(
                format,
                failure,
                (value) => value.diagnostics[0].message,
              );
              // Parser errors may contain source snippets, including sensitive values.
              if (format === "json") write(rendered);
              else writeError(rendered);
              throw new ApplyFailedError();
            }
            const specification = await preflightRepositoryCreation(
              loaded,
              input,
            );
            const rendered = renderOutput(
              format,
              buildRepositoryCreationPreview(loaded, specification),
              renderRepositoryCreationPreview,
            );
            if (format === "json" || specification.ready) {
              write(rendered);
            } else {
              writeError(rendered);
            }
            if (!specification.ready) {
              throw new ApplyFailedError();
            }
          }),
      ),
  );

  root.command(
    "template",
    new Command()
      .description("Template operations.")
      .command(
        "print",
        new Command()
          .description("Print an effective repository template.")
          .arguments("<template:string>")
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: yaml or json.", {
            default: "yaml",
          })
          .action(async (commandOptions, template: string) => {
            if (
              commandOptions.format !== "yaml" &&
              commandOptions.format !== "json"
            ) {
              throw new Error(
                "Unsupported output format: " + commandOptions.format +
                  ". Expected yaml or json",
              );
            }

            const loaded = await loadConfigurationDirectory(
              commandOptions.path,
              template,
            );
            const identity = resolveTemplateIdentity(loaded, template);
            const effectiveTemplate = toSchemaCompatibleRepositoryTemplate(
              loaded.templates[identity],
            );
            write(
              commandOptions.format === "json"
                ? JSON.stringify(effectiveTemplate, null, 2)
                : stringify(effectiveTemplate),
            );
          }),
      )
      .command(
        "list",
        new Command()
          .description("List configured repository templates.")
          .option("-p, --path <path:string>", "Configuration directory.", {
            default: ".",
          })
          .option("--format <format:string>", "Output format: text or json.", {
            default: "text",
          })
          .action(async (commandOptions) => {
            const format = parseOutputFormat(commandOptions.format);
            const loaded = await loadConfigurationDirectory(
              commandOptions.path,
            );
            await validateLoadedConfiguration(loaded);
            const result = listTemplates(loaded);
            write(renderOutput(format, result, renderTemplateList));
          }),
      )
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
          .option("--quiet", "Suppress normal output.")
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
          .option(
            "--creation",
            "Analyze creation authorization separately (requires a template).",
          )
          .action(async (commandOptions, template?: string) => {
            const format = parsePermissionOutputFormat(commandOptions.format);
            const loaded = await loadConfigurationDirectory(
              commandOptions.path,
              template,
            );
            await validateLoadedConfiguration(loaded, template);
            if (commandOptions.creation) {
              if (!template) throw new Error("--creation requires a template");
              const analysis = requiredPermissionsForRepositoryCreation(
                loaded,
                template,
              );
              if (format === "github-output") {
                throw new Error(
                  "Creation permissions have distinct lifecycle scopes; use --format text or json",
                );
              }
              write(renderOutput(format, analysis, (value) =>
                [
                  `Creation target organization: ${value.organization}`,
                  "Organization repository creation authorization:",
                  renderPermissionRequirements(value.creation),
                  "Selector metadata:",
                  renderPermissionRequirements(value.selectorMetadata),
                  "Post-creation reconciliation (including deferred API work):",
                  renderPermissionRequirements(value.reconciliation),
                  "Initial Git bootstrap:",
                  renderPermissionRequirements(value.gitBootstrap),
                  ...value.constraints,
                ].join("\n")));
              return;
            }
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

interface TemplateListEntry {
  readonly identity: string;
  readonly name: string | null;
  readonly path: string;
}

interface TemplateListResult {
  readonly templates: readonly TemplateListEntry[];
  readonly summary: {
    readonly total: number;
  };
}

function listTemplates(loaded: LoadedConfiguration): TemplateListResult {
  const templates = Object.entries(loaded.templates)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([identity, template]) => {
      const path = loaded.templatePaths?.[identity];
      if (path === undefined) {
        throw new Error("Template source path is unavailable: " + identity);
      }

      return {
        identity,
        name: template.name ?? null,
        path,
      };
    });

  return {
    templates,
    summary: { total: templates.length },
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderTemplateList(result: TemplateListResult): string {
  const rows = result.templates.map((template) => [
    template.identity,
    template.name ?? "-",
    template.path,
  ]);
  const headers = ["TEMPLATE", "NAME", "PATH"];
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[index].length),
    )
  );
  const line = (values: readonly string[]) =>
    values.map((value, index) => value.padEnd(widths[index])).join("  ")
      .trimEnd();

  return [
    line(headers),
    ...rows.map(line),
    "",
    `Summary: ${result.summary.total} template${
      result.summary.total === 1 ? "" : "s"
    }`,
  ].join("\n");
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
    validateRawQuietArgument(args);
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

function validateRawQuietArgument(args: readonly string[]): void {
  if (!args.includes("--quiet")) {
    return;
  }

  const supportsQuiet = args[0] === "plan" ||
    args[0] === "apply" ||
    (args[0] === "template" && args[1] === "validate");

  if (!supportsQuiet) {
    throw new Error("Unknown option --quiet");
  }
}

function environmentHas(name: string): boolean {
  try {
    return Deno.env.has(name);
  } catch {
    return false;
  }
}

function parseSecretBoolean(value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error(
      "--include-secrets requires a boolean value: true or false.",
    );
  }
  return value === "true";
}

function renderValidationResult(
  valid: boolean,
  diagnostics: readonly RuntimeReferenceDiagnostic[],
  issues: readonly ConfigurationValidationIssue[],
): string {
  const errors = issues.map((issue) =>
    "Error [" + issue.code + "] " +
    (issue.template === undefined ? "" : "[" + issue.template + "] ") +
    (issue.path === undefined ? "" : issue.path + ": ") +
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
