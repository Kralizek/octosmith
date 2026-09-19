import type { Operation, Plan } from "../plan/types.ts";
import type {
  AppliedOperationLike,
  ReportedOperation,
  RepositoryReport,
} from "./types.ts";

export function reportPlannedRepository(
  template: string,
  plan: Plan,
): RepositoryReport {
  return {
    repository: plan.repository,
    template,
    status: plan.operations.length === 0 ? "unchanged" : "planned",
    operations: plan.operations.map((operation) => ({
      operation: reportOperation(operation),
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
  const skipped = operations.some((item) => item.status === "skipped");

  if (skipped && !failed) {
    throw new Error("Skipped operations require a failed operation");
  }

  return {
    repository,
    template,
    status: failed
      ? applied > 0 ? "partially-applied" : "failed"
      : operations.length === 0
      ? "unchanged"
      : "applied",
    operations: operations.map((item) => ({
      operation: reportOperation(item.operation),
      status: item.status,
      ...(item.error !== undefined && { error: item.error }),
    })),
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

function reportOperation(operation: Operation): ReportedOperation {
  return {
    type: operation.type,
    details: operationDetails(operation),
  };
}

function operationDetails(operation: Operation): Record<string, unknown> {
  switch (operation.type) {
    case "update-repository-settings":
    case "update-actions-settings":
    case "update-actions-oidc":
      return { settings: operation.settings };
    case "set-custom-property":
      return { name: operation.name, value: operation.value };
    case "set-team-permission":
      return {
        team: operation.permission.team,
        permission: operation.permission.permission.name,
      };
    case "remove-team-permission":
      return { team: operation.team };
    case "set-actions-variable":
      return { name: operation.variable.name, value: "[redacted]" };
    case "remove-actions-variable":
      return { name: operation.name };
    case "set-actions-secret":
    case "set-dependabot-secret":
      return { name: operation.secret.name };
    case "remove-actions-secret":
    case "remove-dependabot-secret":
      return { name: operation.secret };
    case "create-ruleset":
      return { ruleset: operation.ruleset };
    case "update-ruleset":
      return { id: operation.id, changes: operation.changes };
    case "delete-ruleset":
      return { id: operation.id, name: operation.name };
    case "create-environment":
    case "update-environment":
      return {
        name: operation.environment.name,
        ...(operation.type === "update-environment" && {
          collections: operation.collections,
        }),
        ...(operation.environment.variables !== undefined && {
          variables: operation.environment.variables.map((variable) => ({
            name: variable.name,
            value: "[redacted]",
          })),
        }),
        ...(operation.environment.secrets !== undefined && {
          secrets: operation.environment.secrets.map((secret) => secret.name),
        }),
      };
    case "delete-environment":
      return { name: operation.name };
    case "create-file":
    case "update-file":
      return { path: operation.file.path, ensure: operation.file.ensure };
    case "delete-file":
      return { path: operation.path };
  }
}
