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
  matchesScope,
  type RepositoryMetadata,
  resolveDesiredState,
  type RuntimeValueProvider,
  shouldIncludeSecrets,
} from "./configuration/resolve.ts";
import {
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

/** Stages of the nontransactional repository creation lifecycle. */
export type RepositoryCreationStage =
  | "configuration"
  | "preflight"
  | "availability"
  | "creation"
  | "metadata"
  | "classification"
  | "reconciliation";

/** Lifecycle outcome, separate from ordinary reconciliation outcomes. */
export type RepositoryCreationStatus =
  | "preflight_rejected"
  | "name_collision"
  | "creation_failed"
  | "metadata_failed"
  | "classification_failed"
  | "reconciliation_failed"
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
}

/** Provision, verify and reconcile GitHub resources without ever initializing Git. */
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
        value: typeof value === "boolean" ? String(value) : value,
      });
      assignment.status = "applied";
    }
    completedStages.push(stage);
    stage = "classification";
    const discovery = await discoverRepositories(
      client,
      loaded,
      repository.name,
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
      classification.template !== specification.template
    ) {
      throw new CreationStageError(
        "Actual repository metadata does not uniquely match the selected template; normal reconciliation was not attempted.",
      );
    }
    completedStages.push(stage);
    stage = "reconciliation";
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
        specification.template,
        loaded.templates[specification.template],
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
      const desired = withoutSkippedRuntimeValues(
        resolved,
        skippedRuntimeReferences,
      );
      const source = new GitHubRepositoryStateSource(client, organization);
      const current = await readCurrentState(source, desired, undefined, {
        scope: "github-only",
      });
      deferred.push(
        ...creationDeferredWork(
          desired,
          current.history?.initialized === false ||
            current.bootstrapBranchPending !== undefined,
        ),
      );
      const plan = buildPlan(current, desired, {
        scope: "github-only",
        skippedRuntimeReferences,
      });
      assertClassificationPreserved(
        loaded,
        actual,
        specification.template,
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
      if (error instanceof RuntimeReferenceProviderError) {
        diagnostics.push(...error.diagnostics);
      }
      repositoryReport = reportFailedRepository(
        repository.name,
        error instanceof RuntimeReferenceError
          ? error
          : new Error(safeCreationError(error)),
        specification.template,
        loaded.templates[specification.template].name,
        diagnostics,
      );
    }
    report = {
      organization,
      startedAt,
      completedAt: new Date(),
      mode: "apply",
      repositories: [repositoryReport],
    };
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
    return result(deferred.length > 0 ? "awaiting_bootstrap" : "completed");
  } catch (error) {
    const status: RepositoryCreationStatus =
      stage === "configuration" || stage === "preflight"
        ? "preflight_rejected"
        : stage === "metadata"
        ? "metadata_failed"
        : stage === "classification"
        ? "classification_failed"
        : stage === "reconciliation"
        ? "reconciliation_failed"
        : "creation_failed";
    return result(
      status,
      error,
      repository
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
  desired: DesiredState,
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
    ...(empty && desired.rulesets !== undefined
      ? [{
        resource: "rulesets" as const,
        targets: desired.rulesets.map((ruleset) => ruleset.name),
        reason:
          "Defer all ruleset reconciliation until bootstrap provides branch references and avoids blocking the first push.",
      }]
      : []),
    ...(empty && desired.settings?.archived !== undefined
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
