import type { Plan } from "../plan/types.ts";
import type { AppliedOperationLike, RepositoryReport } from "./types.ts";

export function reportPlannedRepository(
  template: string,
  plan: Plan,
): RepositoryReport {
  return {
    repository: plan.repository,
    template,
    status: plan.operations.length === 0 ? "unchanged" : "planned",
    operations: plan.operations.map((operation) => ({
      operation,
      status: "planned",
    })),
  };
}

export function reportAppliedRepository(
  template: string,
  repository: string,
  operations: readonly AppliedOperationLike[],
): RepositoryReport {
  const applied = operations.filter((item) => item.status === "applied").length;
  const failed = operations.some((item) => item.status === "failed");

  return {
    repository,
    template,
    status: failed
      ? applied > 0 ? "partially-applied" : "failed"
      : operations.length === 0
      ? "unchanged"
      : "applied",
    operations,
  };
}

export function reportFailedRepository(
  repository: string,
  error: unknown,
  template?: string,
): RepositoryReport {
  return {
    repository,
    ...(template !== undefined && { template }),
    status: "failed",
    operations: [],
    error: error instanceof Error ? error.message : String(error),
  };
}
