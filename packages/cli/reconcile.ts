import {
  buildPlan,
  buildReconciliationEvaluations,
  type DesiredState,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  type Plan,
  type Report,
  reportAppliedRepository,
  reportFailedRepository,
  reportPlannedRepository,
  resolveDesiredState,
  type RuntimeValueProvider,
} from "@octosmith/core";
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
} from "@octosmith/github";

export type ReconcileMode = "plan" | "apply";

export interface ReconciliationRuntime {
  discover(
    loaded: LoadedConfiguration,
    repository?: string,
  ): Promise<RepositoryDiscoveryResult>;

  read(
    desired: DesiredState,
  ): Promise<import("@octosmith/core").CurrentState>;

  apply(plan: Plan): Promise<ApplyPlanResult>;
}

export interface GitHubRuntimeOptions {
  readonly token: string;
  readonly secretValue?: RuntimeValueProvider;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly trace?: (entry: GitHubResponseTrace) => void;
}

export function createGitHubRuntime(
  options: GitHubRuntimeOptions,
): ReconciliationRuntime {
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
      source = new GitHubRepositoryStateSource(
        client,
        loaded.configuration.organization,
      );
      sink = new GitHubRepositoryMutationSink({
        client,
        owner: loaded.configuration.organization,
        secretValue,
      });

      return await discoverRepositories(client, loaded, repository);
    },

    async read(desired) {
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

export interface ReconcileOptions {
  readonly path: string;
  readonly mode: ReconcileMode;
  readonly repository?: string;
  readonly values?: RuntimeValueProvider;
  readonly now?: () => Date;
}

export async function reconcile(
  runtime: ReconciliationRuntime,
  options: ReconcileOptions,
): Promise<Report> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  if (options.repository !== undefined && options.repository.length === 0) {
    throw new Error("Repository target must not be empty");
  }

  const loaded = await loadConfigurationDirectory(options.path);
  const discovery = await runtime.discover(loaded, options.repository);
  const results: import("@octosmith/core").RepositoryReport[] = discovery
    .failures.map((failure) =>
      reportFailedRepository(failure.repository, failure.error)
    );
  const values = options.values ?? environmentValue;

  for (const repository of discovery.repositories) {
    let template: string | undefined;

    try {
      const desired = await resolveDesiredState(loaded, repository, values);
      template = desired.template;
      const current = await runtime.read(desired);
      const plan = buildPlan(current, desired);
      const evaluations = buildReconciliationEvaluations(
        desired,
        plan.operations,
      );

      if (options.mode === "plan") {
        results.push(
          reportPlannedRepository(desired.template, plan, evaluations),
        );
        continue;
      }

      const applied = await runtime.apply(plan);
      results.push(
        reportAppliedRepository(
          desired.template,
          desired.repository,
          evaluations,
          applied.operations,
        ),
      );
    } catch (error) {
      results.push(reportFailedRepository(repository.name, error, template));
    }
  }

  return {
    organization: loaded.configuration.organization,
    startedAt,
    completedAt: now(),
    repositories: results,
  };
}

function environmentValue(name: string): string {
  const value = Deno.env.get(name);

  if (value === undefined) {
    throw new Error("Missing environment value: " + name);
  }

  return value;
}
