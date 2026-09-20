import type {
  ReconciliationItemReport,
  Report,
  RepositoryReport,
} from "./types.ts";

export interface RenderReportOptions {
  readonly verbose?: boolean;
}

export function renderReport(
  report: Report,
  options: RenderReportOptions = {},
): string {
  const lines = [
    "OctoSmith report for " + report.organization,
    "",
  ];

  for (const repository of report.repositories) {
    lines.push(renderRepository(repository));

    for (const item of repository.items) {
      if (item.status === "unchanged" && !options.verbose) {
        continue;
      }

      lines.push("  " + renderItem(item));
    }

    if (repository.error) {
      lines.push("  ✗ " + repository.error);
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

function renderItem(item: ReconciliationItemReport): string {
  const prefix = statusSymbol(item.status) + " ";
  const error = item.error ? " — " + item.error : "";

  return prefix + describeItem(item) + error;
}

function describeItem(item: ReconciliationItemReport): string {
  const details = item.details;

  switch (item.type) {
    case "repository-settings":
      return "Repository settings" + settingsSuffix(details.settings);
    case "custom-property":
      return "Custom property " + String(details.name) +
        actionSuffix(details, "value");
    case "actions-settings":
      return "Actions settings" + settingsSuffix(details.settings);
    case "actions-oidc":
      return "Actions OIDC" + settingsSuffix(details.settings);
    case "actions-variable":
      return "Actions variable " + String(details.name) + actionSuffix(details);
    case "actions-secret":
      return "Actions secret " + String(details.name) + actionSuffix(details);
    case "dependabot-secret":
      return "Dependabot secret " + String(details.name) + actionSuffix(details);
    case "team-permission": {
      const permission = details.permission !== undefined
        ? " — permission: " + formatValue(details.permission)
        : actionSuffix(details);
      return "Team " + String(details.team) + permission;
    }
    case "ruleset":
      return "Ruleset " + String(details.name) + actionSuffix(details);
    case "environment":
      return "Environment " + String(details.name) + actionSuffix(details);
    case "file":
      return "File " + String(details.path) + actionSuffix(details);
  }
}

function actionSuffix(
  details: Readonly<Record<string, unknown>>,
  valueKey?: string,
): string {
  const action = details.action;
  const value = valueKey === undefined ? undefined : details[valueKey];

  if (action === undefined && value === undefined) {
    return "";
  }

  if (action !== undefined && value !== undefined) {
    return " — " + action + ": " + formatValue(value);
  }

  if (action !== undefined) {
    return " — " + String(action);
  }

  return " — " + valueKey + ": " + formatValue(value);
}

function settingsSuffix(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  const entries = flattenObject(value);

  return entries.length === 0
    ? ""
    : " — " + entries.map(([key, child]) =>
      key + ": " + formatValue(child)
    ).join(", ");
}

function flattenObject(
  value: unknown,
  prefix = "",
): readonly [string, unknown][] {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [[prefix, value]];
  }

  const result: [string, unknown][] = [];

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length === 0 ? key : prefix + "." + key;

    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      result.push(...flattenObject(child, path));
    } else {
      result.push([path, child]);
    }
  }

  return result;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(formatValue).join(", ") + "]";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function statusSymbol(
  status:
    | RepositoryReport["status"]
    | ReconciliationItemReport["status"],
): string {
  switch (status) {
    case "unchanged":
      return "-";
    case "planned":
      return "→";
    case "applied":
      return "✓";
    case "partially-applied":
    case "failed":
      return "✗";
    case "skipped":
      return "·";
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
