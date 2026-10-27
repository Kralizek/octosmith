import {
  preflightRepositoryCreation,
  type RepositoryCreationInput,
  type RepositoryCreationOptions,
  type RepositoryCreationSpecification,
} from "./configuration/creation.ts";
import {
  loadConfigurationDirectory,
  type LoadedConfiguration,
} from "./configuration/load.ts";
import {
  classifyResource,
  ManagedFileResolutionError,
  matchesScope,
  type RepositoryMetadata,
  resolveDesiredState,
  type RuntimeValueProvider,
  shouldIncludeSecrets,
} from "./configuration/resolve.ts";
import {
  collectRuntimeReferences,
  MissingRuntimeValueError,
  preflightRuntimeReferences,
  type RuntimeReference,
  type RuntimeReferenceDiagnostic,
  RuntimeReferenceError,
  RuntimeReferenceProviderError,
  secretPolicyDiagnostics,
  withoutSkippedRuntimeValues,
} from "./configuration/runtime_references.ts";
import { applyPlan } from "./github/apply.ts";
import { type GitHubClient, GitHubRequestError } from "./github/client.ts";
import {
  type CreatedRepository,
  createOrganizationRepository,
} from "./github/create_repository.ts";
import { discoverRepositories } from "./github/discovery.ts";
import { readCurrentState } from "./github/read_state.ts";
import { GitHubRepositoryMutationSink } from "./github/rest_mutation_sink.ts";
import { GitHubRepositoryStateSource } from "./github/rest_state_source.ts";
import { buildApplyEvaluations, buildPlan } from "./plan/build.ts";
import type { Operation } from "./plan/types.ts";
import {
  reportAppliedRepository,
  reportFailedRepository,
} from "./report/build.ts";
import type { Report, RepositoryReport } from "./report/types.ts";
import type { DesiredState } from "./state/types.ts";
import { normalizeCustomPropertyValue } from "./state/resources.ts";
import type {
  GitBootstrapResult,
  RepositoryGitBootstrap,
} from "./git_bootstrap.ts";

/** Stages of the nontransactional repository creation lifecycle. */
export type RepositoryCreationStage =
  | "configuration"
  | "preflight"
  | "availability"
  | "creation"
  | "metadata"
  | "classification"
  | "reconciliation"
  | "bootstrap_preparation"
  | "git_bootstrap"
  | "deferred_reconciliation";

/** Lifecycle outcome, separate from ordinary reconciliation outcomes. */
export type RepositoryCreationStatus =
  | "preflight_rejected"
  | "name_collision"
  | "creation_failed"
  | "metadata_failed"
  | "classification_failed"
  | "reconciliation_failed"
  | "bootstrap_failed"
  | "bootstrapped_not_reconciled"
  | "awaiting_bootstrap"
  | "completed";

/** Work to resume by re-reading state and rebuilding a plan after bootstrap. */
export interface RepositoryCreationDeferredWork {
  readonly resource: "files" | "default_branch" | "rulesets" | "archival";
  readonly targets: readonly string[];
  readonly reason: string;
}

/** Request for reusable creation, accepting loaded or on-disk configuration. */
export interface RepositoryCreationRequest extends RepositoryCreationInput {
  readonly configuration: LoadedConfiguration | string;
  readonly includeSecrets?: boolean;
  readonly skipMissingValues?: boolean;
}

/** Dependencies and preflight controls shared by library and CLI hosts. */
export interface CreateRepositoryOptions extends RepositoryCreationOptions {
  readonly client: GitHubClient | (() => Promise<GitHubClient>);
  readonly values?: RuntimeValueProvider;
  readonly secretValues?: RuntimeValueProvider;
  readonly bootstrap?: RepositoryGitBootstrap;
}

/** Safe, composable lifecycle result; no operations or file/runtime contents. */
export interface RepositoryCreationResult {
  readonly kind: "repository_creation";
  readonly version: 1;
  readonly organization?: string;
  readonly template?: string;
  readonly requestedName?: string;
  readonly repository?: CreatedRepository;
  readonly status: RepositoryCreationStatus;
  readonly completedStages: readonly RepositoryCreationStage[];
  readonly metadataAssignments: readonly {
    readonly kind: "team" | "custom_property";
    readonly target: string;
    readonly status: "applied" | "failed";
  }[];
  readonly failedStage?: RepositoryCreationStage;
  readonly error?: { readonly message: string; readonly httpStatus?: number };
  readonly recovery?: string;
  readonly specification?: RepositoryCreationSpecification;
  readonly deferred: readonly RepositoryCreationDeferredWork[];
  readonly report?: Report;
  readonly bootstrap?: GitBootstrapResult;
  readonly deferredReconciliationAttempted: boolean;
  readonly deferredReport?: Report;
}

/** Provision, verify, bootstrap once and reconcile an organization repository. */
export async function createRepository(
  request: RepositoryCreationRequest,
  options: CreateRepositoryOptions,
): Promise<RepositoryCreationResult> {
  const completedStages: RepositoryCreationStage[] = [];
  let stage: RepositoryCreationStage = "configuration";
  let organization: string | undefined;
  let specification: RepositoryCreationSpecification | undefined;
  let repository: CreatedRepository | undefined;
  let report: Report | undefined;
  let deferredReport: Report | undefined;
  let bootstrap: GitBootstrapResult | undefined;
  let deferredReconciliationAttempted = false;
  const deferred: RepositoryCreationDeferredWork[] = [];
  const metadataAssignments: {
    kind: "team" | "custom_property";
    target: string;
    status: "applied" | "failed";
  }[] = [];
  const result = (
    status: RepositoryCreationStatus,
    error?: unknown,
    recovery?: string,
  ): RepositoryCreationResult => ({
    kind: "repository_creation",
    version: 1,
    organization,
    template: specification?.template,
    requestedName: specification?.repository?.name ?? request.name,
    repository,
    status,
    completedStages: [...completedStages],
    metadataAssignments,
    ...(error !== undefined && {
      failedStage: stage,
      error: {
        message: safeCreationError(error),
        ...(error instanceof GitHubRequestError &&
          { httpStatus: error.status }),
      },
    }),
    ...(recovery !== undefined && { recovery }),
    specification,
    deferred,
    report,
    bootstrap,
    deferredReport,
    deferredReconciliationAttempted,
  });

  try {
    const loaded = typeof request.configuration === "string"
      ? await loadConfigurationDirectory(request.configuration)
      : request.configuration;
    organization = loaded.configuration.organization;
    completedStages.push(stage);
    stage = "preflight";
    specification = await preflightRepositoryCreation(loaded, request, options);
    if (!specification.ready || !specification.repository?.visibility) {
      return result(
        "preflight_rejected",
        new CreationStageError(
          "Preflight rejected; resolve the specification diagnostics before creating a repository.",
        ),
      );
    }
    completedStages.push(stage);
    const metadata = specification.repository;
    const visibility = specification.repository.visibility;
    stage = "availability";
    const client = typeof options.client === "function"
      ? await options.client()
      : options.client;
    const path = "/repos/" + encodeURIComponent(organization) + "/" +
      encodeURIComponent(metadata.name);
    const existing = await client.request<unknown>("GET", path, {
      allowNotFound: true,
    });
    if (existing !== undefined) {
      return result(
        "name_collision",
        new CreationStageError(
          "Repository name already exists; no repository was created or adopted.",
        ),
        "The name already exists. Use ordinary plan/apply for an in-scope repository; creation never adopts existing repositories or retries with another name.",
      );
    }
    completedStages.push(stage);
    stage = "creation";
    try {
      repository = await createOrganizationRepository(client, organization, {
        name: metadata.name,
        visibility,
      });
    } catch (error) {
      if (
        error instanceof GitHubRequestError && error.status === 422 &&
        await client.request<unknown>("GET", path, { allowNotFound: true }) !==
          undefined
      ) {
        return result(
          "name_collision",
          new CreationStageError(
            "Repository name collided during creation; no new name was generated and no existing repository was adopted.",
          ),
          "Inspect GitHub and use ordinary plan/apply only if the existing repository belongs in scope.",
        );
      }
      throw error;
    }
    completedStages.push(stage);
    const configured = loaded.templates[specification.template].repository;
    deferred.push(...creationDeferredWork({
      ...configured,
      files: Object.keys(configured.files ?? {}).map((path) => ({ path })),
    }, true));
    stage = "metadata";
    const values = options.values ?? missingValue;
    const secretValues = options.secretValues ?? values;
    const sink = new GitHubRepositoryMutationSink({
      client,
      owner: organization,
      secretValue: secretValues,
      scope: "github-only",
      fileChanges: loaded.configuration.repositories.fileChanges,
    });
    // Selector membership has no permission level; use least privilege until normal reconciliation.
    for (const team of specification.choices.teams) {
      const assignment: (typeof metadataAssignments)[number] = {
        kind: "team",
        target: team,
        status: "failed",
      };
      metadataAssignments.push(assignment);
      await sink.apply(repository.name, {
        type: "set-team-permission",
        permission: { team, permission: { kind: "built-in", name: "pull" } },
      });
      assignment.status = "applied";
    }
    for (
      const [name, value] of Object.entries(
        specification.choices.customProperties,
      )
    ) {
      const assignment: (typeof metadataAssignments)[number] = {
        kind: "custom_property",
        target: name,
        status: "failed",
      };
      metadataAssignments.push(assignment);
      await sink.apply(repository.name, {
        type: "set-custom-property",
        name,
        value: normalizeCustomPropertyValue(value),
      });
      assignment.status = "applied";
    }
    completedStages.push(stage);
    stage = "classification";
    const created = repository;
    const selected = specification;
    const owner = organization;
    const verifyMetadata = async () => {
      const discovery = await discoverRepositories(
        client,
        loaded,
        created.name,
      );
      const actual = discovery.repositories[0];
      if (discovery.failures[0]?.error instanceof GitHubRequestError) {
        throw discovery.failures[0].error;
      }
      if (
        discovery.failures.length > 0 || discovery.repositories.length !== 1 ||
        !actual
      ) {
        throw new CreationStageError(
          "Actual repository metadata is outside the configured scope or could not be re-read; normal reconciliation was not attempted.",
        );
      }
      const classification = classifyResource(loaded, actual);
      if (
        classification.status !== "matched" ||
        classification.template !== selected.template
      ) {
        throw new CreationStageError(
          "Actual repository metadata does not uniquely match the selected template; normal reconciliation was not attempted.",
        );
      }
      return actual;
    };
    let actual = await verifyMetadata();
    completedStages.push(stage);
    stage = "reconciliation";
    let desired: DesiredState | undefined;
    let initialDefaultBranch: string | undefined;
    let completedSecrets: readonly RuntimeReference[] = [];
    const reconcile = async (afterPush = false): Promise<Report> => {
      const startedAt = new Date();
      const diagnostics: RuntimeReferenceDiagnostic[] = [];
      let repositoryReport: RepositoryReport;
      try {
        const skippedRuntimeReferences: RuntimeReference[] = [];
        const includeSecrets = shouldIncludeSecrets(
          loaded.configuration,
          request.includeSecrets,
        );
        const runtimeValues = preflightRuntimeReferences(
          selected.template,
          loaded.templates[selected.template],
          actual,
          values,
          {
            secretValues,
            includeSecrets,
            skipMissingValues: request.skipMissingValues,
            onSkipped: (reference, diagnostic) => {
              skippedRuntimeReferences.push(reference);
              diagnostics.push(diagnostic);
            },
          },
        );
        const resolved = await resolveDesiredState(
          loaded,
          actual,
          runtimeValues,
          {
            skippedRuntimeReferences,
            includeSecrets,
          },
        );
        diagnostics.push(...secretPolicyDiagnostics(resolved));
        desired = withoutSkippedRuntimeValues(
          resolved,
          skippedRuntimeReferences,
        );
        if (afterPush) {
          desired = {
            ...desired,
            defaultBranchDrift: "enforce",
            settings: { ...desired.settings, defaultBranch: bootstrap!.branch },
          };
        }
        const source = new GitHubRepositoryStateSource(client, owner);
        let current = await readCurrentState(source, desired, undefined, {
          scope: "github-only",
        });
        if (!afterPush) initialDefaultBranch = current.settings.defaultBranch;
        if (!afterPush && current.history?.initialized !== false) {
          throw new CreationStageError(
            "Unexpected existing repository history; creation never adopts or overwrites it.",
          );
        }
        if (
          afterPush &&
          (!bootstrap?.pushConfirmed || current.history?.initialized !== true)
        ) {
          throw new CreationStageError("Pushed history could not be verified.");
        }
        if (afterPush && current.bootstrapBranchPending) {
          if (
            current.bootstrapBranchPending.branch !== bootstrap?.branch ||
            current.bootstrapBranchPending.head !== bootstrap.commitSha
          ) {
            throw new CreationStageError("Unexpected branch after push.");
          }
          current = { ...current, bootstrapBranchPending: undefined };
        }
        if (!afterPush) {
          deferred.splice(
            0,
            deferred.length,
            ...creationDeferredWork(
              desired,
              current.history?.initialized === false ||
                current.bootstrapBranchPending !== undefined,
            ),
          );
        }
        const planningSkipped = [
          ...skippedRuntimeReferences,
          ...(afterPush
            ? completedSecrets.filter((reference) => {
              switch (reference.scope) {
                case "actions":
                  return current.actions.secrets.includes(reference.target);
                case "dependabot":
                  return current.dependabot.secrets.includes(reference.target);
                case "environment":
                  return current.environments.some((environment) =>
                    environment.name === reference.environment &&
                    environment.secrets.includes(reference.target)
                  );
              }
            })
            : []),
        ];
        let plan = buildPlan(current, desired, {
          scope: "github-only",
          skippedRuntimeReferences: planningSkipped,
        });
        if (afterPush) {
          // Archival must not make any remaining API operations unwritable.
          const archival: Operation[] = [];
          const writable: Operation[] = [];
          for (const operation of plan.operations) {
            if (
              operation.type === "update-repository-settings" &&
              operation.settings.archived === true
            ) {
              const { archived, ...settings } = operation.settings;
              if (Object.keys(settings).length) {
                writable.push({
                  type: "update-repository-settings",
                  settings,
                });
              }
              archival.push({
                type: "update-repository-settings",
                settings: { archived },
              });
            } else writable.push(operation);
          }
          plan = { ...plan, operations: [...writable, ...archival] };
        }
        assertClassificationPreserved(
          loaded,
          actual,
          selected.template,
          plan.operations,
        );
        const evaluations = buildApplyEvaluations(
          desired,
          plan.operations,
          current,
          { scope: "github-only" },
        );
        const applied = await applyPlan(sink, plan, {
          formatError: safeCreationError,
        });
        if (
          !afterPush && includeSecrets &&
          applied.operations.every(({ status }) => status === "applied") &&
          !applied.error
        ) {
          // Secret values are opaque to GitHub reads, so ordinary planning always
          // writes them. Within this lifecycle, preserve confirmed deliveries.
          completedSecrets = collectRuntimeReferences(
            loaded.templates[selected.template],
          )
            .filter((reference) =>
              reference.kind === "secret" &&
              !skippedRuntimeReferences.some((skipped) =>
                skipped.path === reference.path
              )
            );
        }
        if (afterPush) {
          const remaining = applied.operations.filter(({ status }) =>
            status !== "applied"
          );
          const targets = (
            resource: RepositoryCreationDeferredWork["resource"],
          ) =>
            remaining.flatMap(({ operation }) => {
              if (
                resource === "default_branch" &&
                operation.type === "update-repository-settings" &&
                operation.settings.defaultBranch !== undefined
              ) return [operation.settings.defaultBranch];
              if (
                resource === "archival" &&
                operation.type === "update-repository-settings" &&
                operation.settings.archived !== undefined
              ) return ["archived"];
              if (resource === "rulesets") {
                if (operation.type === "create-ruleset") {
                  return [operation.ruleset.name];
                }
                if (operation.type === "update-ruleset") {
                  return [operation.changes.name];
                }
                if (operation.type === "delete-ruleset") {
                  return [operation.name];
                }
              }
              return [];
            });
          deferred.splice(
            0,
            deferred.length,
            ...deferred.flatMap((work) => {
              const pending = targets(work.resource);
              return pending.length ? [{ ...work, targets: pending }] : [];
            }),
          );
        }
        repositoryReport = reportAppliedRepository(
          desired.template,
          desired.repository,
          evaluations,
          applied.operations,
          desired.templateName,
          diagnostics,
          applied.pullRequests,
          applied.error,
        );
      } catch (error) {
        if (error instanceof ManagedFileResolutionError) throw error;
        if (error instanceof RuntimeReferenceProviderError) {
          diagnostics.push(...error.diagnostics);
        }
        repositoryReport = reportFailedRepository(
          created.name,
          error instanceof RuntimeReferenceError
            ? error
            : new Error(safeCreationError(error)),
          selected.template,
          loaded.templates[selected.template].name,
          diagnostics,
        );
      }
      return {
        organization: owner,
        startedAt,
        completedAt: new Date(),
        mode: "apply",
        repositories: [repositoryReport],
      };
    };
    report = await reconcile();
    const repositoryReport = report.repositories[0];
    if (
      repositoryReport.status === "failed" ||
      repositoryReport.status === "partially-applied"
    ) {
      return result(
        "reconciliation_failed",
        new CreationStageError(
          "GitHub-side reconciliation failed; inspect the regular reconciliation report.",
        ),
        "The repository was verified and retained. Correct the reported failure, then run ordinary plan/apply. Bootstrap deferred work before enforcing branch-dependent settings.",
      );
    }
    completedStages.push(stage);
    stage = "bootstrap_preparation";
    if (!desired) {
      throw new CreationStageError("Desired state was not resolved.");
    }
    // GitHub resolves the organization/enterprise default on the empty repository.
    // There is no separate REST organization-default-branch field.
    const branch = desired.settings?.defaultBranch ??
      initialDefaultBranch ?? "main";
    bootstrap = {
      branch,
      fileCount: (desired.files ?? []).filter((file) =>
        file.ensure !== "absent"
      ).length,
      prepared: false,
      commitCreated: false,
      pushAttempted: false,
      pushConfirmed: false,
      outcome: "failed",
      failure: "preparation",
    };
    if (!options.bootstrap) {
      throw new CreationStageError(
        "Git bootstrap transport is required; provide an authenticated RepositoryGitBootstrap.",
      );
    }
    completedStages.push(stage);
    stage = "git_bootstrap";
    bootstrap = await options.bootstrap.bootstrap({
      organization,
      repository: repository.name,
      branch,
      files: desired.files ?? [],
      assertEmpty: async () => {
        const branches = await client.get<readonly unknown[]>(
          path + "/branches",
          { per_page: 1 },
        );
        if (branches.length !== 0) {
          throw new CreationStageError(
            "Unexpected existing branches; bootstrap stopped.",
          );
        }
        const source = new GitHubRepositoryStateSource(client, owner);
        const history = await source.getRepositoryHistory(
          created.name,
          branch,
          { allowEmptyBranchList: true },
        );
        if (history.initialized) {
          throw new CreationStageError(
            "Unexpected existing history; bootstrap stopped.",
          );
        }
      },
    });
    if (bootstrap.outcome !== "completed") {
      return result(
        bootstrap.pushConfirmed
          ? "bootstrapped_not_reconciled"
          : "bootstrap_failed",
        new CreationStageError(
          "Git bootstrap failed (" + bootstrap.failure +
            "); raw Git diagnostics are omitted.",
        ),
        bootstrap.pushAttempted
          ? "Repository retained. Do not rerun resource create. Inspect remote branches and compare the reported commit SHA before recovery; a lost push response may have changed the remote. Complete or repair content manually, then run ordinary plan/apply."
          : "Repository retained without bootstrap content. Do not rerun resource create. Correct the preparation/authentication failure and initialize the retained repository manually, then run ordinary plan/apply.",
      );
    }
    completedStages.push(stage);
    deferred.splice(
      0,
      deferred.length,
      ...deferred.filter(({ resource }) => resource !== "files"),
    );
    stage = "deferred_reconciliation";
    deferredReconciliationAttempted = true;
    actual = await verifyMetadata();
    const source = new GitHubRepositoryStateSource(client, organization);
    if (
      await source.getBranchHead(repository.name, branch) !==
        bootstrap.commitSha
    ) {
      throw new CreationStageError(
        "Remote branch no longer matches the initial commit; deferred reconciliation stopped.",
      );
    }
    deferredReport = await reconcile(true);
    if (
      ["failed", "partially-applied"].includes(
        deferredReport.repositories[0].status,
      )
    ) {
      return result(
        "bootstrapped_not_reconciled",
        new CreationStageError(
          "Repository bootstrapped; deferred GitHub reconciliation failed. Inspect the deferred report.",
        ),
        "Do not rerun resource create. Repository and initial commit are retained. Correct the reported failure, verify classification, then run ordinary plan/apply.",
      );
    }
    deferred.length = 0;
    completedStages.push(stage);
    return result("completed");
  } catch (error) {
    if (
      error instanceof ManagedFileResolutionError && !bootstrap?.pushConfirmed
    ) {
      stage = "bootstrap_preparation";
      bootstrap = {
        branch: "",
        fileCount: 0,
        prepared: false,
        commitCreated: false,
        pushAttempted: false,
        pushConfirmed: false,
        outcome: "failed",
        failure: "invalid_files",
      };
    }
    const status: RepositoryCreationStatus =
      stage === "configuration" || stage === "preflight"
        ? "preflight_rejected"
        : stage === "metadata"
        ? "metadata_failed"
        : stage === "classification"
        ? "classification_failed"
        : stage === "reconciliation"
        ? "reconciliation_failed"
        : stage === "deferred_reconciliation"
        ? "bootstrapped_not_reconciled"
        : stage === "bootstrap_preparation" || stage === "git_bootstrap"
        ? "bootstrap_failed"
        : "creation_failed";
    return result(
      status,
      error,
      bootstrap?.pushConfirmed
        ? "Repository bootstrapped and retained. Do not rerun resource create. Verify remote state and classification, then run ordinary plan/apply to finish deferred work."
        : repository && bootstrap
        ? "Repository retained. Do not rerun resource create. Inspect remote branches before manually completing bootstrap, then run ordinary plan/apply. No automatic push retry or deletion is performed."
        : repository
        ? "Repository retained; never automatically deleted. Repair selector teams/properties and verify scope and unique classification manually. Ordinary plan/apply cannot discover or repair repositories outside scope."
        : "No repository was adopted. Check credentials, organization policy and name availability before explicitly retrying. If the creation response was lost, inspect GitHub before retrying.",
    );
  }
}

function missingValue(name: string): never {
  throw new MissingRuntimeValueError(name);
}

function safeCreationError(error: unknown): string {
  if (error instanceof CreationStageError) return error.message;
  if (error instanceof GitHubRequestError) {
    return `GitHub API request failed (HTTP ${error.status}); check authentication, permissions, organization policy and request constraints.`;
  }
  if (error instanceof RuntimeReferenceError) return error.message;
  return "Creation stage failed; inspect configuration, actual metadata and runtime-value availability. Repository contents and provider/API error bodies are omitted.";
}

class CreationStageError extends Error {}

function creationDeferredWork(
  desired: {
    readonly files?: readonly { readonly path: string }[];
    readonly settings?: Pick<
      NonNullable<DesiredState["settings"]>,
      "defaultBranch" | "archived"
    >;
    readonly rulesets?: readonly { readonly name: string }[];
  },
  empty: boolean,
): RepositoryCreationDeferredWork[] {
  return [
    ...(desired.files?.length
      ? [{
        resource: "files" as const,
        targets: desired.files.map((file) => file.path),
        reason:
          "Managed files belong to the single-commit Git bootstrap (#111), never creation-time API delivery.",
      }]
      : []),
    ...(empty && desired.settings?.defaultBranch
      ? [{
        resource: "default_branch" as const,
        targets: [desired.settings.defaultBranch],
        reason:
          "The branch has no reference before bootstrap; do not fabricate one.",
      }]
      : []),
    ...(empty && desired.rulesets?.length
      ? [{
        resource: "rulesets" as const,
        targets: desired.rulesets.map((ruleset) => ruleset.name),
        reason:
          "Defer all ruleset reconciliation until bootstrap provides branch references and avoids blocking the first push.",
      }]
      : []),
    ...(empty && desired.settings?.archived === true
      ? [{
        resource: "archival" as const,
        targets: ["archived"],
        reason:
          "Archival is deferred so the repository remains writable for bootstrap.",
      }]
      : []),
  ];
}

function assertClassificationPreserved(
  loaded: LoadedConfiguration,
  metadata: RepositoryMetadata,
  template: string,
  operations: readonly Operation[],
): void {
  const teams = new Set(metadata.teams);
  const properties = { ...metadata.properties };
  let visibility = metadata.visibility;
  for (const operation of operations) {
    if (operation.type === "remove-team-permission") {
      teams.delete(operation.team);
    }
    if (operation.type === "set-team-permission") {
      teams.add(operation.permission.team);
    }
    if (operation.type === "set-custom-property") {
      if (operation.value === null) delete properties[operation.name];
      else properties[operation.name] = operation.value;
    }
    if (operation.type === "update-repository-settings") {
      visibility = operation.settings.visibility ?? visibility;
    }
  }
  const projected = {
    name: metadata.name,
    visibility,
    teams: [...teams],
    properties,
  };
  const classification = classifyResource(loaded, projected);
  if (
    !matchesScope(loaded.configuration.repositories.scope, projected) ||
    classification.status !== "matched" || classification.template !== template
  ) {
    throw new CreationStageError(
      "Reconciliation would remove selector-required metadata or change classification. Correct strict collection declarations before retrying.",
    );
  }
}
