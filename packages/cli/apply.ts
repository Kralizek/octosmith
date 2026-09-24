import {
  buildApplyEvaluations,
  buildPlan,
  type DesiredState,
  type LoadedConfiguration,
  matchesSelector,
  type Plan,
  preflightRuntimeReferences,
  reportAppliedRepository,
  reportFailedRepository,
  reportPlannedRepository,
  resolveDesiredState,
  type RuntimeValueProvider,
} from "@octosmith/octosmith";
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
  discover(
    loaded: LoadedConfiguration,
    resource?: string,
  ): Promise<RepositoryDiscoveryResult>;

  read(
    desired: DesiredState,
  ): Promise<import("@octosmith/octosmith").CurrentState>;

  apply(plan: Plan): Promise<ApplyPlanResult>;
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

  return {
    async discover(loaded, repository) {
      options.traceGroup?.("organization");
      source = new GitHubRepositoryStateSource(
        client,
        loaded.configuration.organization,
      );
      sink = new GitHubRepositoryMutationSink({
        client,
        owner: loaded.configuration.organization,
        secretValue,
        fileChanges: loaded.configuration.repositories.fileChanges ?? {
          mode: "pull_request",
        },
      });

      return await discoverRepositories(client, loaded, repository);
    },

    async read(desired) {
      options.traceGroup?.("repository: " + desired.repository);

      if (!source) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      return await readCurrentState(source, desired);
    },

    async apply(plan) {
      if (!sink) {
        throw new Error("GitHub runtime has not discovered repositories yet");
      }

      return await applyPlan(sink, plan);
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
  const values = options.values ?? environmentValue;

  const addResult = async (
    result: import("@octosmith/octosmith").RepositoryReport,
  ) => {
    await options.onRepositoryApplied(result);
  };

  for (const failure of discovery.failures) {
    await addResult(
      reportFailedRepository(failure.repository, failure.error),
    );
  }

  for (const repository of discovery.repositories) {
    const matchingTemplates = Object.entries(loaded.templates).filter((
      [, template],
    ) => matchesSelector(template.match, repository));

    if (
      matchingTemplates.length === 0 &&
      loaded.configuration.repositories.settings?.unmatchedRepositories ===
        "ignore"
    ) {
      continue;
    }

    let template: string | undefined;
    let templateName: string | undefined;
    let result: import("@octosmith/octosmith").RepositoryReport;

    try {
      if (matchingTemplates.length === 1) {
        template = matchingTemplates[0][0];
        const selectedTemplate = matchingTemplates[0][1];
        const resolvedValues = preflightRuntimeReferences(
          template,
          selectedTemplate,
          repository,
          values,
        );
        const desired = await resolveDesiredState(
          loaded,
          repository,
          resolvedValues,
        );
        template = desired.template;
        templateName = desired.templateName;
        const current = await runtime.read(desired);
        const plan = buildPlan(current, desired);
        const evaluations = buildApplyEvaluations(
          desired,
          plan.operations,
        );

        if (options.mode === "plan") {
          result = reportPlannedRepository(
          desired.template,
          plan,
          evaluations,
            desired.templateName,
          );
        } else {
          const applied = await runtime.apply(plan);
          result = reportAppliedRepository(
            desired.template,
            desired.repository,
            evaluations,
            applied.operations,
            desired.templateName,
          );
        }
      } else {
        const desired = await resolveDesiredState(loaded, repository, values);
        template = desired.template;
        templateName = desired.templateName;
        const current = await runtime.read(desired);
        const plan = buildPlan(current, desired);
        const evaluations = buildApplyEvaluations(desired, plan.operations);
        result = options.mode === "plan"
          ? reportPlannedRepository(
            desired.template,
            plan,
            evaluations,
            desired.templateName,
          )
          : reportAppliedRepository(
            desired.template,
            desired.repository,
            evaluations,
            (await runtime.apply(plan)).operations,
            desired.templateName,
          );
      }
    } catch (error) {
      result = reportFailedRepository(
        repository.name,
        error,
        template,
        templateName,
      );
    }

    await addResult(result);
  }
}

function environmentValue(name: string): string {
  const value = Deno.env.get(name);

  if (value === undefined) {
    throw new Error("Missing environment value: " + name);
  }

  return value;
}
