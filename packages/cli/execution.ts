import {
  type ApplyOperationResult,
  type ApplyPlanResult,
  type ExecutableResourcePlan,
  type Plan,
  reportAppliedRepository,
  reportFailedRepository,
  type RepositoryReport,
} from "@octosmith/octosmith";

/** Minimal runtime capability required to execute an already-built plan. */
export interface ExecutablePlanRuntime {
  apply(plan: Plan): Promise<ApplyPlanResult>;
}

/** Hook run immediately before one resource starts mutating. */
export type BeforeExecutableResource = (
  resource: ExecutableResourcePlan,
) => void | Promise<void>;

/** Execute already-built resource plans without rebuilding or reinterpreting them. */
export async function executeExecutableResources(
  runtime: ExecutablePlanRuntime,
  resources: readonly ExecutableResourcePlan[],
  onRepositoryApplied: (
    report: RepositoryReport,
  ) => void | Promise<void>,
  beforeResource?: BeforeExecutableResource,
): Promise<void> {
  for (const resource of resources) {
    try {
      await beforeResource?.(resource);

      const applied = await runtime.apply(resource.plan);
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
