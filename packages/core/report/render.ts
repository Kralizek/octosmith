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
    JSON.stringify(operation.operation.details) + error;
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
