import {
  buildApplyEvaluations,
  buildPlan,
  type DesiredState,
  type ExecutableResourcePlan,
  fileExecutionBranch,
  hashCanonical,
  type LoadedConfiguration,
  matchesScope,
  type Operation,
  preflightRuntimeReferences,
  projectOwnedCurrentState,
  reportFailedRepository,
  reportPlannedRepository,
  resolveDesiredState,
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
      const matches = Object.entries(loadedConfiguration.templates).filter(
        ([, template]) => matchesScope(template.match, metadata),
      );
      if (
        matches.length !== 1 ||
        matches[0][0] !== resource.desired.template
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
        ),
      );
      const after = await hashCanonical(
        projectOwnedCurrentState(
          current,
          resource.desired,
          resource.plan.operations,
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
  readonly values?: RuntimeValueProvider;
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

  const discovery = await runtime.discover(loaded, options.resource);
  const values = options.values ?? runtime.value ?? environmentValue;
  const failures: import("@octosmith/octosmith").RepositoryReport[] = [];
  const prepared: ExecutableResourcePlan[] = [];

  for (const failure of discovery.failures) {
    failures.push(
      reportFailedRepository(failure.repository, failure.error),
    );
  }

  for (const repository of discovery.repositories) {
    const matchingTemplates = Object.entries(loaded.templates).filter((
      [, candidate],
    ) => matchesScope(candidate.match, repository));

    if (
      matchingTemplates.length === 0 &&
      loaded.configuration.repositories.settings?.unmatchedRepositories ===
        "ignore"
    ) {
      continue;
    }

    let template: string | undefined;
    let templateName: string | undefined;

    try {
      let runtimeValues = values;

      if (matchingTemplates.length === 1) {
        template = matchingTemplates[0][0];
        runtimeValues = preflightRuntimeReferences(
          template,
          matchingTemplates[0][1],
          repository,
          values,
        );
      }

      const desired = await resolveDesiredState(
        loaded,
        repository,
        runtimeValues,
      );
      template = desired.template;
      templateName = desired.templateName;

      const current = await runtime.read(desired);
      const plan = buildPlan(current, desired);
      const evaluations = buildApplyEvaluations(
        desired,
        plan.operations,
      );
      const executable = { desired, current, plan, evaluations };

      prepared.push(executable);
      await options.onPlanBuilt?.(executable);
    } catch (error) {
      failures.push(
        reportFailedRepository(
          repository.name,
          error,
          template,
          templateName,
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
    throw new Error("Missing environment value: " + name);
  }

  return value;
}
