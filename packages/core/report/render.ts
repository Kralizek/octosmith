import type { Operation } from "../plan/types.ts";
import type { OperationReport, Report, RepositoryReport } from "./types.ts";

export function renderReport(report: Report): string {
  const lines = [
    "OctoSmith report for " + report.organization,
    "",
  ];

  for (const repository of report.repositories) {
    lines.push(renderRepository(repository));

    for (const operation of repository.operations) {
      lines.push("  " + renderOperation(operation));
    }

    if (repository.error) {
      lines.push("  error: " + repository.error);
    }
  }

  const summary = summarize(report);
  lines.push(
    "",
    "Summary: " +
      summary.unchanged + " unchanged, " +
      summary.planned + " planned, " +
      summary.applied + " applied, " +
      summary.partiallyApplied + " partially-applied, " +
      summary.failed + " failed",
  );

  return lines.join("\n");
}

function renderRepository(repository: RepositoryReport): string {
  const template = repository.template ? " [" + repository.template + "]" : "";

  return statusSymbol(repository.status) + " " +
    repository.repository + template + " — " + repository.status;
}

function renderOperation(operation: OperationReport): string {
  const error = operation.error ? " — " + operation.error : "";

  return statusSymbol(operation.status) + " " +
    operation.operation.type + " — " + operation.status + " " +
    JSON.stringify(operationDetails(operation.operation)) + error;
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
    case "set-repository-variable":
      return { name: operation.variable.name, value: "[redacted]" };
    case "remove-repository-variable":
      return { name: operation.name };
    case "set-repository-secret":
    case "remove-repository-secret":
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
        ...(operation.type === "update-environment" &&
          { collections: operation.collections }),
        ...(operation.environment.variables !== undefined && {
          variables: operation.environment.variables.map((variable) => ({
            name: variable.name,
            value: "[redacted]",
          })),
        }),
        ...(operation.environment.secrets !== undefined &&
          { secrets: operation.environment.secrets }),
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

function statusSymbol(
  status: RepositoryReport["status"] | OperationReport["status"],
): string {
  switch (status) {
    case "unchanged":
    case "applied":
      return "✓";
    case "planned":
      return "~";
    case "partially-applied":
    case "failed":
      return "!";
    case "skipped":
      return "-";
  }
}

function summarize(report: Report): {
  readonly unchanged: number;
  readonly planned: number;
  readonly applied: number;
  readonly partiallyApplied: number;
  readonly failed: number;
} {
  let unchanged = 0;
  let planned = 0;
  let applied = 0;
  let partiallyApplied = 0;
  let failed = 0;

  for (const repository of report.repositories) {
    switch (repository.status) {
      case "unchanged":
        unchanged++;
        break;
      case "planned":
        planned++;
        break;
      case "applied":
        applied++;
        break;
      case "partially-applied":
        partiallyApplied++;
        break;
      case "failed":
        failed++;
        break;
    }
  }

  return { unchanged, planned, applied, partiallyApplied, failed };
}
