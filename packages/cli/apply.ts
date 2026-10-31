import {
  assertRepositoryOwnerCapabilities,
  buildApplyEvaluations,
  buildPlan,
  classifyResource,
  type DesiredState,
  type ExecutableResourcePlan,
  fileExecutionBranch,
  hashCanonical,
  inspectResource,
  type LoadedConfiguration,
  LocalGitBootstrap,
  MissingRuntimeValueError,
  type Operation,
  preflightRuntimeReferences,
  projectOwnedCurrentState,
  type PullRequestResult,
  reportFailedRepository,
  reportPlannedRepository,
  type RepositoryGitBootstrap,
  resolveDesiredState,
  type ResolvedRepositoryOwner,
  resolveRepositoryOwner,
  type ResourceInspection,
  type RuntimeReference,
  type RuntimeReferenceDiagnostic,
  type RuntimeValueProvider,
  secretPolicyDiagnostics,
  shouldIncludeSecrets,
  withoutSkippedRuntimeValues,
} from "@octosmith/octosmith";
import { executeExecutableResources } from "./execution.ts";
import {
  applyPlan,
  type ApplyPlanResult,
  discoverRepositories,
  FetchGitHubClient,
  type GitHubClient,
  GitHubRepositoryBootstrap,
  GitHubRepositoryMutationSink,
  GitHubRepositoryStateSource,
  type GitHubResponseTrace,
  readCurrentState,
  type RepositoryDiscoveryResult,
} from "@octosmith/octosmith";
import { resolveTemplateIdentity } from "./template.ts";

/** Describes apply mode. */
export type ApplyMode = "plan" | "apply";

/** Describes apply runtime. */
export interface ApplyRuntime {
  readonly client?: GitHubClient;
  readonly value?: RuntimeValueProvider;
  readonly bootstrap?: RepositoryGitBootstrap;
  readonly owner?: ResolvedRepositoryOwner;

  discover(
    loaded: LoadedConfiguration,
    resource?: string,
  ): Promise<RepositoryDiscoveryResult>;

  read(
    desired: DesiredState,
    operations?: readonly Operation[],
  ): Promise<import("@octosmith/octosmith").CurrentState>;

  prepare(resource: ExecutableResourcePlan): void | Promise<void>;

  recheck(resource: ExecutableResourcePlan): void | Promise<void>;

  apply(
    resource: ExecutableResourcePlan,
    onPullRequest?: (result: PullRequestResult) => void | Promise<void>,
  ): Promise<ApplyPlanResult>;
}

/** Describes GitHub runtime options. */
export interface GitHubRuntimeOptions {
  readonly token: string;
  readonly secretValue?: RuntimeValueProvider;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly trace?: (entry: GitHubResponseTrace) => void;
  readonly traceGroup?: (name: string) => void;
}

/** Create the GitHub-backed runtime used by plan and apply commands. */
export function createGitHubRuntime(
  options: GitHubRuntimeOptions,
): ApplyRuntime {
  const client = new FetchGitHubClient({
    token: options.token,
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    trace: options.trace,
  });
  const secretValue = options.secretValue ?? environmentValue;
  let source: GitHubRepositoryStateSource | undefined;
  let sink: GitHubRepositoryMutationSink | undefined;
  let loadedConfiguration: LoadedConfiguration | undefined;
  let fileChanges:
    LoadedConfiguration["configuration"]["repositories"]["fileChanges"];
  let resolvedOwner: ResolvedRepositoryOwner | undefined;
  const preparedSinks = new Map<
    string,
    import("@octosmith/octosmith").RepositoryMutationSink
  >();

  return {
    client,
    value: secretValue,
    get owner() {
      return resolvedOwner;
    },
    bootstrap: new LocalGitBootstrap({
      token: () => options.token,
      baseUrl: options.baseUrl,
    }),

    async discover(loaded, repository) {
      options.traceGroup?.("owner");
      loadedConfiguration = loaded;
      const owner = await resolveRepositoryOwner(
        client,
        loaded.configuration.organization,
      );
      resolvedOwner = owner;
      assertRepositoryOwnerCapabilities(loaded, owner);
      source = new GitHubRepositoryStateSource(
        client,
        owner.login,
      );
      fileChanges = loaded.configuration.repositories.fileChanges ?? {
        mode: "pull_request",
      };
      sink = new GitHubRepositoryMutationSink({
        bootstrap: new GitHubRepositoryBootstrap(
          client,
          owner.login,
        ),
        client,
        owner: owner.login,
        secretValue,
        fileChanges,
      });
      preparedSinks.clear();

      return await discoverRepositories(
        client,
        loaded,
        repository,
        owner,
      );
    },

    async read(desired, operations) {
      options.traceGroup?.("repository: " + desired.repository);

      if (!source) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      return await readCurrentState(source, desired, operations, {
        authoritativeFiles: fileChanges?.mode === "pull_request",
      });
    },

    async prepare(resource) {
      if (!sink) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      validateFileDeliveryPreconditions(resource, fileChanges);
      if (fileChanges?.mode === "pull_request") {
        const expected = {
          branch: resource.current.filesBranch ??
            resource.current.settings.defaultBranch,
          ...(resource.current.history?.initialized === false
            ? { uninitialized: true }
            : { baseSha: resource.current.filesBaseSha }),
          ...(resource.current.bootstrapFile
            ? { bootstrapCleanup: { sha: resource.current.bootstrapFile.sha } }
            : resource.current.history?.initialized === false
            ? { bootstrapCleanup: { afterInitialization: true } }
            : {}),
          files: [...(resource.desired.files ?? [])].sort((left, right) =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : 0
          ),
        };
        if (
          (resource.current.filesBaseSha === undefined &&
            resource.current.history?.initialized !== false) ||
          resource.plan.managedFiles === undefined ||
          (await hashCanonical(expected)).hash !==
            (await hashCanonical(resource.plan.managedFiles)).hash
        ) {
          throw new Error(
            "Missing or incomplete managed-file desired-state snapshot",
          );
        }
      }
      const prepared = sink.prepare
        ? await sink.prepare(
          resource.plan.repository,
          resource.plan.operations,
          resource.current.filesBranch ??
            resource.current.settings.defaultBranch,
          resource.plan.managedFiles,
          (resource.skippedRuntimeReferences?.length ?? 0) === 0,
        )
        : sink;
      preparedSinks.set(resource.plan.repository, prepared);
    },

    async recheck(resource) {
      if (!source || !loadedConfiguration || !resolvedOwner) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      const discovery = await discoverRepositories(
        client,
        loadedConfiguration,
        resource.desired.repository,
        resolvedOwner,
      );
      if (
        discovery.failures.length > 0 || discovery.repositories.length !== 1
      ) {
        throw new Error("Resource selection changed after apply preparation");
      }
      const metadata = discovery.repositories[0];
      const classification = classifyResource(loadedConfiguration, metadata);
      if (
        (classification.status !== "matched" &&
          classification.status !== "fallback") ||
        classification.template !== resource.desired.template
      ) {
        throw new Error("Resource template changed after apply preparation");
      }

      const current = await readCurrentState(
        source,
        resource.desired,
        resource.plan.operations,
        { authoritativeFiles: fileChanges?.mode === "pull_request" },
      );
      const before = await hashCanonical(
        projectOwnedCurrentState(
          resource.current,
          resource.desired,
          resource.plan.operations,
          resource.skippedRuntimeReferences,
        ),
      );
      const after = await hashCanonical(
        projectOwnedCurrentState(
          current,
          resource.desired,
          resource.plan.operations,
          resource.skippedRuntimeReferences,
        ),
      );

      if (before.hash !== after.hash) {
        throw new Error("Resource state changed after apply preparation");
      }
    },

    async apply(resource, onPullRequest) {
      const prepared = preparedSinks.get(resource.plan.repository);
      if (!prepared) {
        throw new Error(
          "Executable resource was not prepared before mutation: " +
            resource.plan.repository,
        );
      }

      preparedSinks.delete(resource.plan.repository);
      return await applyPlan(
        {
          prepare: () => prepared,
          apply: prepared.apply.bind(prepared),
        },
        resource.plan,
        { onPullRequest },
      );
    },
  };
}

/** Describes apply options. */
export interface ApplyOptions {
  readonly onPullRequest?: (result: PullRequestResult) => void | Promise<void>;
  readonly mode: ApplyMode;
  readonly resource?: string;
  readonly template?: string;
  /** Override runtime values for variables; secrets use the runtime provider. */
  readonly values?: RuntimeValueProvider;
  readonly skipMissingValues?: boolean;
  readonly includeSecrets?: boolean;
  readonly onResourceInspected?: (resource: ResourceInspection) => void;
  readonly onRepositoryApplied: (
    report: import("@octosmith/octosmith").RepositoryReport,
  ) => void | Promise<void>;
  readonly onPlanBuilt?: (
    resource: ExecutableResourcePlan,
  ) => void | Promise<void>;
}

/** Plan or apply configuration for the targeted resource set. */
export async function apply(
  runtime: ApplyRuntime,
  loaded: LoadedConfiguration,
  options: ApplyOptions,
): Promise<void> {
  if (options.resource !== undefined && options.resource.length === 0) {
    throw new Error("Resource target must not be empty");
  }
  if (options.resource !== undefined && options.template !== undefined) {
    throw new Error(
      "Cannot combine a template filter with a repository target",
    );
  }
  const template = options.template === undefined
    ? undefined
    : resolveTemplateIdentity(loaded, options.template);

  const discovery = await runtime.discover(loaded, options.resource);
  const repositories = template === undefined
    ? discovery.repositories
    : discovery.repositories.filter((repository) => {
      const classification = classifyResource(loaded, repository);
      return (classification.status === "matched" ||
        classification.status === "fallback") &&
        classification.template === template;
    });
  const values = options.values ?? runtime.value ?? environmentValue;
  const secretValues = runtime.value ?? environmentValue;
  const includeSecrets = shouldIncludeSecrets(
    loaded.configuration,
    options.includeSecrets,
  );
  const failures: import("@octosmith/octosmith").RepositoryReport[] = [];
  const prepared: ExecutableResourcePlan[] = [];

  for (const failure of discovery.failures) {
    failures.push(
      reportFailedRepository(failure.repository, failure.error),
    );
  }

  for (const repository of repositories) {
    let template: string | undefined;
    let templateName: string | undefined;
    const skippedRuntimeReferences: RuntimeReference[] = [];
    const diagnostics: RuntimeReferenceDiagnostic[] = [];

    try {
      const inspection = inspectResource(
        loaded,
        repository,
        runtime.owner?.login,
      );
      options.onResourceInspected?.(inspection);
      if (
        inspection.status === "unmatched" &&
        loaded.configuration.repositories.settings?.unmatchedRepositories ===
          "ignore"
      ) {
        continue;
      }
      let runtimeValues = values;

      if (
        inspection.status === "matched" || inspection.status === "fallback"
      ) {
        template = inspection.template;
        runtimeValues = preflightRuntimeReferences(
          template,
          loaded.templates[template],
          repository,
          values,
          {
            secretValues,
            includeSecrets,
            skipMissingValues: options.skipMissingValues,
            onSkipped: (reference, diagnostic) => {
              skippedRuntimeReferences.push(reference);
              diagnostics.push(diagnostic);
            },
          },
        );
      }

      const resolvedDesired = await resolveDesiredState(
        loaded,
        repository,
        runtimeValues,
        { skippedRuntimeReferences, includeSecrets },
      );
      diagnostics.push(...secretPolicyDiagnostics(resolvedDesired));
      template = resolvedDesired.template;
      templateName = resolvedDesired.templateName;

      const current = await runtime.read(resolvedDesired);
      const plan = buildPlan(current, resolvedDesired, {
        skippedRuntimeReferences,
      });
      const desired = withoutSkippedRuntimeValues(
        resolvedDesired,
        skippedRuntimeReferences,
      );
      const evaluations = buildApplyEvaluations(
        desired,
        plan.operations,
        current,
      );
      const executable = {
        desired,
        current,
        plan,
        evaluations,
        ...(diagnostics.length > 0 && { diagnostics }),
        ...(skippedRuntimeReferences.length > 0 && {
          skippedRuntimeReferences,
        }),
      };

      prepared.push(executable);
      await options.onPlanBuilt?.(executable);
    } catch (error) {
      failures.push(
        reportFailedRepository(
          repository.name,
          error,
          template,
          templateName,
          diagnostics,
        ),
      );
    }
  }

  if (options.mode === "plan") {
    for (const failure of failures) {
      await options.onRepositoryApplied(failure);
    }
    for (const resource of prepared) {
      await options.onRepositoryApplied(
        reportPlannedRepository(
          resource.desired.template,
          resource.plan,
          resource.evaluations,
          resource.desired.templateName,
          resource.diagnostics,
        ),
      );
    }
    return;
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      await options.onRepositoryApplied(failure);
    }
    for (const resource of prepared) {
      await options.onRepositoryApplied(
        reportFailedRepository(
          resource.desired.repository,
          new Error(
            "Apply aborted before mutation because another resource failed during preparation",
          ),
          resource.desired.template,
          resource.desired.templateName,
          resource.diagnostics,
          resource.evaluations,
        ),
      );
    }
    return;
  }

  await executeExecutableResources(
    runtime,
    prepared,
    options.onRepositoryApplied,
    options.onPullRequest,
  );
}

function validateFileDeliveryPreconditions(
  resource: ExecutableResourcePlan,
  fileChanges:
    LoadedConfiguration["configuration"]["repositories"]["fileChanges"],
): void {
  const hasFileOperations = resource.plan.operations.some((operation) =>
    operation.type === "create-file" ||
    operation.type === "update-file" ||
    operation.type === "delete-file" ||
    operation.type === "cleanup-repository-bootstrap"
  );
  if (!hasFileOperations) {
    return;
  }

  const files = new Map(
    resource.current.files.map((file) => [file.path, file]),
  );
  for (const operation of resource.plan.operations) {
    if (operation.type === "create-file") {
      if (files.has(operation.file.path)) {
        throw new Error(
          "Managed file already exists before execution: " +
            operation.file.path,
        );
      }
    } else if (
      operation.type === "update-file" || operation.type === "delete-file"
    ) {
      const path = operation.type === "update-file"
        ? operation.file.path
        : operation.path;
      if (files.get(path)?.sha !== operation.sha) {
        throw new Error(
          "Managed file SHA does not match the reviewed operation: " + path,
        );
      }
    }
  }

  const effective = fileChanges ?? { mode: "pull_request" as const };
  const effectiveDefaultBranch = fileExecutionBranch(
    resource.current.settings.defaultBranch,
    resource.plan.operations,
  );
  if (
    effectiveDefaultBranch !==
      (resource.current.filesBranch ?? resource.current.settings.defaultBranch)
  ) {
    throw new Error(
      "Managed file snapshot does not match the execution branch",
    );
  }
  if (effective.mode !== "pull_request") {
    return;
  }

  const branch = (effective.pullRequest?.branchPrefix ?? "octosmith/") +
    "reconcile";
  if (branch === effectiveDefaultBranch) {
    throw new Error(
      "Managed file pull-request branch must not match default branch: " +
        branch,
    );
  }
}

/** Resolve runtime values consistently for CLI plan, apply and creation. */
export function environmentValue(name: string): string {
  const value = Deno.env.get(name);

  if (value === undefined) {
    throw new MissingRuntimeValueError(name);
  }

  return value;
}
