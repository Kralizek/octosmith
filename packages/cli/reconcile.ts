import {
  buildPlan,
  type BuildPlanOptions,
  type DesiredState,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  type Plan,
  type Report,
  reportAppliedRepository,
  reportFailedRepository,
  reportPlannedRepository,
  type RepositoryMetadata,
  resolveDesiredState,
  type RuntimeValueProvider,
} from "@octosmith/core";
import type { ApplyPlanResult } from "@octosmith/github";

export type ReconcileMode = "plan" | "apply";

export interface ReconciliationRuntime {
  discover(
    loaded: LoadedConfiguration,
  ): Promise<readonly RepositoryMetadata[]>;

  read(
    desired: DesiredState,
    options: BuildPlanOptions,
  ): Promise<import("@octosmith/core").CurrentState>;

  apply(plan: Plan): Promise<ApplyPlanResult>;
}

export interface ReconcileOptions extends BuildPlanOptions {
  readonly path: string;
  readonly mode: ReconcileMode;
  readonly values?: RuntimeValueProvider;
  readonly now?: () => Date;
}

export async function reconcile(
  runtime: ReconciliationRuntime,
  options: ReconcileOptions,
): Promise<Report> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const loaded = await loadConfigurationDirectory(options.path);
  const repositories = await runtime.discover(loaded);
  const results: import("@octosmith/core").RepositoryReport[] = [];
  const values = options.values ?? environmentValue;

  for (const repository of repositories) {
    let template: string | undefined;

    try {
      const desired = await resolveDesiredState(loaded, repository, values);
      template = desired.template;
      const current = await runtime.read(desired, {
        collections: options.collections,
      });
      const plan = buildPlan(current, desired, {
        collections: options.collections,
      });

      if (options.mode === "plan") {
        results.push(reportPlannedRepository(desired.template, plan));
        continue;
      }

      const applied = await runtime.apply(plan);
      results.push(
        reportAppliedRepository(
          desired.template,
          desired.repository,
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
