import {
  type ApplyOperationResult,
  type ApplyPlanResult,
  assertPersistedOperationsExecutable,
  type ExecutableResourcePlan,
  reportAppliedRepository,
  reportFailedRepository,
  type RepositoryReport,
} from "@octosmith/octosmith";

/** Minimal runtime capability required to execute an already-built plan. */
export interface ExecutablePlanRuntime {
  prepare(resource: ExecutableResourcePlan): void | Promise<void>;
  recheck(resource: ExecutableResourcePlan): void | Promise<void>;
  apply(resource: ExecutableResourcePlan): Promise<ApplyPlanResult>;
}

/** Execute already-built resource plans without rebuilding or reinterpreting them. */
export async function executeExecutableResources(
  runtime: ExecutablePlanRuntime,
  resources: readonly ExecutableResourcePlan[],
  onRepositoryApplied: (
    report: RepositoryReport,
  ) => void | Promise<void>,
): Promise<void> {
  for (const resource of resources) {
    assertPersistedOperationsExecutable(resource.plan.operations);
    await runtime.prepare(resource);
  }

  for (const resource of resources) {
    try {
      await runtime.recheck(resource);

      const applied = await runtime.apply(resource);
      await onRepositoryApplied(
        reportAppliedRepository(
          resource.desired.template,
          resource.desired.repository,
          resource.evaluations,
          applied.operations,
          resource.desired.templateName,
        ),
      );

      if (containsFailure(applied.operations)) {
        break;
      }
    } catch (error) {
      await onRepositoryApplied(
        reportFailedRepository(
          resource.desired.repository,
          error,
          resource.desired.template,
          resource.desired.templateName,
        ),
      );
      break;
    }
  }
}

function containsFailure(
  operations: readonly ApplyOperationResult[],
): boolean {
  return operations.some((operation) => operation.status === "failed");
}
