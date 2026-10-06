import {
  buildApplyEvaluations,
  buildPlan,
  classifyResource,
  type DesiredState,
  type ExecutableResourcePlan,
  fileExecutionBranch,
  hashCanonical,
  inspectResource,
  type LoadedConfiguration,
  type RuntimeReference,
  type RuntimeReferenceDiagnostic,
  MissingRuntimeValueError,
  type Operation,
  preflightRuntimeReferences,
  projectOwnedCurrentState,
  reportFailedRepository,
  reportPlannedRepository,
  resolveDesiredState,
  type ResourceInspection,
  type RuntimeValueProvider,
} from "@octosmith/octosmith";
import { executeExecutableResources } from "./execution.ts";
import {
  applyPlan,
  type ApplyPlanResult,
  discoverRepositories,
  FetchGitHubClient,
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
  readonly value?: RuntimeValueProvider;

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

  apply(resource: ExecutableResourcePlan): Promise<ApplyPlanResult>;
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
  const preparedSinks = new Map<
    string,
    import("@octosmith/octosmith").RepositoryMutationSink
  >();

  return {
    value: secretValue,

    async discover(loaded, repository) {
      options.traceGroup?.("organization");
      loadedConfiguration = loaded;
      source = new GitHubRepositoryStateSource(
        client,
        loaded.configuration.organization,
      );
      fileChanges = loaded.configuration.repositories.fileChanges ?? {
        mode: "pull_request",
      };
      sink = new GitHubRepositoryMutationSink({
        client,
        owner: loaded.configuration.organization,
        secretValue,
        fileChanges,
      });
      preparedSinks.clear();

      return await discoverRepositories(client, loaded, repository);
    },

    async read(desired, operations) {
      options.traceGroup?.("repository: " + desired.repository);

      if (!source) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      return await readCurrentState(source, desired, operations);
    },

    async prepare(resource) {
      if (!sink) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      validateFileDeliveryPreconditions(resource, fileChanges);
      const prepared = sink.prepare
        ? await sink.prepare(
          resource.plan.repository,
          resource.plan.operations,
          resource.current.filesBranch ??
            resource.current.settings.defaultBranch,
        )
        : sink;
      preparedSinks.set(resource.plan.repository, prepared);
    },

    async recheck(resource) {
      if (!source || !loadedConfiguration) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      const discovery = await discoverRepositories(
        client,
        loadedConfiguration,
        resource.desired.repository,
      );
      if (
        discovery.failures.length > 0 || discovery.repositories.length !== 1
      ) {
        throw new Error("Resource selection changed after apply preparation");
      }
      const metadata = discovery.repositories[0];
      const classification = classifyResource(loadedConfiguration, metadata);
      if (
        classification.status !== "matched" ||
        classification.template !== resource.desired.template
      ) {
        throw new Error("Resource template changed after apply preparation");
      }

      const current = await readCurrentState(
        source,
        resource.desired,
        resource.plan.operations,
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

    async apply(resource) {
      const prepared = preparedSinks.get(resource.plan.repository);
      if (!prepared) {
        throw new Error(
          "Executable resource was not prepared before mutation: " +
            resource.plan.repository,
        );
      }

      preparedSinks.delete(resource.plan.repository);
      return await applyPlan(
        { apply: prepared.apply.bind(prepared) },
        resource.plan,
      );
    },
  };
}

/** Describes apply options. */
export interface ApplyOptions {
  readonly mode: ApplyMode;
  readonly resource?: string;
  readonly template?: string;
  readonly values?: RuntimeValueProvider;
  readonly skipMissingValues?: boolean;
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
      return classification.status === "matched" &&
        classification.template === template;
    });
  const values = options.values ?? runtime.value ?? environmentValue;
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
      const inspection = inspectResource(loaded, repository);
      options.onResourceInspected?.(inspection);
      if (
        inspection.status === "unmatched" &&
        loaded.configuration.repositories.settings?.unmatchedRepositories ===
          "ignore"
      ) {
        continue;
      }
      let runtimeValues = values;

      if (inspection.status === "matched") {
        template = inspection.template;
        runtimeValues = preflightRuntimeReferences(
          template,
          loaded.templates[template],
          repository,
          values,
          {
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
      );
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
        ),
      );
    }
    return;
  }

  await executeExecutableResources(
    runtime,
    prepared,
    options.onRepositoryApplied,
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
    operation.type === "delete-file"
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

function environmentValue(name: string): string {
  const value = Deno.env.get(name);

  if (value === undefined) {
    throw new MissingRuntimeValueError(name);
  }

  return value;
}

export function withoutSkippedRuntimeValues(
  desired: DesiredState,
  skipped: readonly RuntimeReference[],
): DesiredState {
  if (skipped.length === 0) {
    return desired;
  }

  const actions = desired.actions === undefined
    ? undefined
    : {
      ...desired.actions,
      secrets: filterSkippedItems(
        desired.actions.secrets,
        skipped,
        "actions",
        "secret",
        (secret) => secret.name,
      ),
      variables: filterSkippedItems(
        desired.actions.variables,
        skipped,
        "actions",
        "variable",
        (variable) => variable.name,
      ),
    };
  const dependabot = desired.dependabot === undefined
    ? undefined
    : {
      ...desired.dependabot,
      secrets: filterSkippedItems(
        desired.dependabot.secrets,
        skipped,
        "dependabot",
        "secret",
        (secret) => secret.name,
      ),
    };
  const environments = desired.environments?.map((environment) => ({
    ...environment,
    secrets: filterSkippedItems(
      environment.secrets,
      skipped,
      "environment",
      "secret",
      (secret) => secret.name,
      environment.name,
    ),
    variables: filterSkippedItems(
      environment.variables,
      skipped,
      "environment",
      "variable",
      (variable) => variable.name,
      environment.name,
    ),
  }));

  return {
    ...desired,
    ...(actions !== undefined && { actions }),
    ...(dependabot !== undefined && { dependabot }),
    ...(environments !== undefined && { environments }),
  };
}

function filterSkippedItems<T>(
  items: readonly T[] | undefined,
  skipped: readonly RuntimeReference[],
  scope: RuntimeReference["scope"],
  kind: RuntimeReference["kind"],
  name: (item: T) => string,
  environment?: string,
): readonly T[] | undefined {
  if (items === undefined) {
    return undefined;
  }

  const skippedNames = new Set(
    skipped.filter((reference) =>
      reference.scope === scope && reference.kind === kind &&
      (environment === undefined || reference.environment === environment)
    ).map((reference) => reference.target),
  );
  const filtered = items.filter((item) => !skippedNames.has(name(item)));

  return skippedNames.size > 0 && filtered.length === 0
    ? undefined
    : filtered;
}
