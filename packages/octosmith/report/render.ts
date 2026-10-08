import type { ApplyItemReport, Report, RepositoryReport } from "./types.ts";
import { describeRuntimeReferenceDiagnostic } from "../configuration/runtime_references.ts";

/** Describes render report options. */
export interface RenderReportOptions {
  readonly verbose?: boolean;
}

/** Render a structured Octosmith report as human-readable text. */
export function renderReport(
  report: Report,
  options: RenderReportOptions = {},
): string {
  const lines = [
    "Octosmith report for " + report.organization,
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

    if (
      repository.error &&
      !(repository.diagnostics ?? []).some((diagnostic) =>
        repository.error!.startsWith(
          describeRuntimeReferenceDiagnostic(diagnostic),
        )
      )
    ) {
      lines.push("  ✗ " + repository.error);
    }
  }

  const unmatchedByType = new Map<
    string,
    { names: string[]; label: string }
  >();
  for (const resource of report.inspection?.resources ?? []) {
    if (resource.status !== "unmatched") {
      continue;
    }
    let group = unmatchedByType.get(resource.type);
    if (group === undefined) {
      group = {
        names: [],
        label: resource.type === "repository"
          ? "repositories"
          : resource.type + "s",
      };
      unmatchedByType.set(resource.type, group);
    }
    const prefix = report.organization + "/";
    group.names.push(
      resource.type === "repository" && resource.name.startsWith(prefix)
        ? resource.name.slice(prefix.length)
        : resource.name,
    );
  }

  if (unmatchedByType.size > 0) {
    lines.push("");
    for (const group of unmatchedByType.values()) {
      lines.push(
        "Unmatched " + group.label + " (" + group.names.length + "):",
      );
      if (group.label === "repositories") {
        const policy = report.unmatchedPolicy ?? "error";
        lines.push(
          "  Policy: " + policy,
          policy === "ignore"
            ? "  These repositories are excluded from reconciliation."
            : report.mode === "apply"
            ? "  Apply cannot complete successfully."
            : "  Plan cannot complete successfully.",
        );
      }
      lines.push(...group.names.map((name) => "  " + name));
    }
  }

  const diagnosticGroups = groupRuntimeDiagnostics(report.repositories);
  const errors = diagnosticGroups.filter((group) =>
    group.diagnostic.severity === "error"
  );
  if (errors.length > 0) {
    lines.push("", "Failures:");
    for (const group of errors) {
      renderDiagnosticGroup(lines, report, group, options.verbose ?? false);
    }
  }

  const skipped = diagnosticGroups.filter((group) =>
    group.diagnostic.code.startsWith("skipped_")
  );
  const warnings = diagnosticGroups.filter((group) =>
    group.diagnostic.severity === "warning" &&
    !group.diagnostic.code.startsWith("skipped_")
  );
  if (skipped.length > 0 || warnings.length > 0) {
    lines.push("", "Warnings:");
    if (skipped.length > 0) {
      lines.push("  Skipped runtime values:");
      for (const group of skipped) {
        const resources = diagnosticResources(report, group);
        const kind = group.diagnostic.code.endsWith("_secret")
          ? "secret"
          : "variable";
        lines.push(
          "    " + group.diagnostic.name + " (" + kind + ") — " +
            resources.length + " repositories",
        );
        if (options.verbose && resources.length > 0) {
          lines.push(
            "      Affected resources:",
            ...resources.map((resource) => "        " + resource),
          );
        }
      }
      lines.push(
        "",
        "  " + skipped.reduce(
          (count, group) => count + diagnosticBindingCount(group),
          0,
        ) + " bindings excluded from reconciliation.",
        "  Existing destination values will not be modified or deleted.",
      );
    }
    for (const group of warnings) {
      renderDiagnosticGroup(lines, report, group, options.verbose ?? false);
    }
  }

  const summary = summarize(report);
  lines.push(
    "",
    "Summary:",
    "  Repositories: " +
      summary.planned + " planned, " +
      summary.unchanged + " unchanged, " +
      summary.applied + " applied, " +
      summary.partiallyApplied + " partially-applied, " +
      summary.failed + " failed" +
      (report.inspection === undefined
        ? ""
        : ", " + report.inspection.summary.unmatched + " unmatched"),
    "  Operations:   " +
      summary.operations.planned + " planned, " +
      summary.operations.applied + " applied, " +
      summary.operations.failed + " failed, " +
      summary.operations.skipped + " skipped",
    "  Exclusions:   " + summary.skippedBindings +
      " skipped runtime bindings",
  );

  const pullRequests = [...new Map(
    [
      ...(report.pullRequestsOpened ?? []),
      ...report.repositories.flatMap((repository) =>
        repository.pullRequestsOpened ?? []
      ),
    ].map((pullRequest) => [
      pullRequest.repository + "#" + pullRequest.number,
      pullRequest,
    ]),
  ).values()];
  if (pullRequests.length > 0) {
    lines.push("", "Pull requests opened (" + pullRequests.length + "):");
    for (const pullRequest of pullRequests) {
      lines.push(
        "  " + pullRequest.repository + " — " + report.organization + "/" +
          pullRequest.repository + "#" + pullRequest.number + " " +
          pullRequest.url,
      );
    }
  }

  return lines.join("\n");
}

function renderDiagnosticGroup(
  lines: string[],
  report: Report,
  group: ReturnType<typeof groupRuntimeDiagnostics>[number],
  verbose: boolean,
): void {
  const resources = diagnosticResources(report, group);
  lines.push("  " + describeRuntimeReferenceDiagnostic(group.diagnostic));
  if (resources.length === 0) {
    return;
  }
  lines.push("  Affected resources (" + resources.length + "):");
  if (verbose) {
    lines.push(...resources.map((resource) => "    " + resource));
  }
}

function diagnosticResources(
  report: Report,
  group: ReturnType<typeof groupRuntimeDiagnostics>[number],
): string[] {
  return [
    ...new Set(
      group.diagnostics.flatMap((diagnostic) =>
        diagnostic.resource === undefined ? [] : [
          diagnostic.resource.type === "repository" &&
            diagnostic.resource.name.startsWith(report.organization + "/")
            ? diagnostic.resource.name.slice(report.organization.length + 1)
            : diagnostic.resource.name,
        ]
      ),
    ),
  ];
}

function diagnosticBindingCount(
  group: ReturnType<typeof groupRuntimeDiagnostics>[number],
): number {
  return new Set(
    group.diagnostics.map((diagnostic) =>
      JSON.stringify([
        diagnostic.resource?.name,
        diagnostic.template,
        diagnostic.path,
      ])
    ),
  ).size;
}

function groupRuntimeDiagnostics(
  repositories: Report["repositories"],
): {
  readonly diagnostic: NonNullable<
    Report["repositories"][number]["diagnostics"]
  >[number];
  readonly diagnostics: NonNullable<
    Report["repositories"][number]["diagnostics"]
  >[number][];
}[] {
  const groups = new Map<
    string,
    {
      diagnostic: NonNullable<
        Report["repositories"][number]["diagnostics"]
      >[number];
      diagnostics: NonNullable<
        Report["repositories"][number]["diagnostics"]
      >[number][];
    }
  >();

  for (const repository of repositories) {
    for (const diagnostic of repository.diagnostics ?? []) {
      const key = JSON.stringify([
        diagnostic.severity,
        diagnostic.code,
        diagnostic.name,
      ]);
      let group = groups.get(key);
      if (group === undefined) {
        group = { diagnostic, diagnostics: [] };
        groups.set(key, group);
      }
      group.diagnostics.push(diagnostic);
    }
  }

  return [...groups.values()];
}

function renderRepository(repository: RepositoryReport): string {
  const template = repository.template
    ? " [" + (repository.templateName ?? repository.template) + "]"
    : "";

  return statusSymbol(repository.status) + " " +
    repository.repository + template + " — " + repository.status;
}

function renderItem(item: ApplyItemReport): string {
  const prefix = statusSymbol(item.status) + " ";
  const error = item.error ? " — " + item.error : "";

  return prefix + describeItem(item) + error;
}

function describeItem(item: ApplyItemReport): string {
  const details = item.details;

  switch (item.type) {
    case "repository-settings":
      return "Repository settings" +
        settingsSuffix(item, details.settings);
    case "custom-property":
      return "Custom property " + String(details.name) +
        actionSuffix(details, "value");
    case "actions-settings":
      return "Actions settings" + settingsSuffix(item, details.settings);
    case "actions-oidc":
      return "Actions OIDC" + settingsSuffix(item, details.settings);
    case "actions-variable":
      return "Actions variable " + String(details.name) +
        actionSuffix(
          details.action === "delete"
            ? { ...details, action: "remove" }
            : details,
        );
    case "actions-secret":
      return "Actions secret " + String(details.name) + actionSuffix(details);
    case "dependabot-secret":
      return "Dependabot secret " + String(details.name) +
        actionSuffix(details);
    case "team-permission": {
      const action = details.action;
      const permission = action === "grant"
        ? " — grant " + formatValue(details.permission)
        : action === "change"
        ? " — " + formatValue(details.beforePermission) + " → " +
          formatValue(details.permission)
        : action === "remove"
        ? " — remove"
        : details.permission !== undefined
        ? " — permission: " + formatValue(details.permission)
        : actionSuffix(details);
      return "Team " + String(details.team) + permission;
    }
    case "ruleset":
      return "Ruleset " + String(details.name) + actionSuffix(details);
    case "environment":
      return "Environment " + String(details.name) + actionSuffix(details);
    case "file":
      return "File " + String(details.path) +
        actionSuffix(
          details.action === "delete"
            ? { ...details, action: "remove" }
            : details,
        );
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

function formatSettingsSuffix(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  const entries = flattenObject(value);

  return entries.length === 0 ? "" : " — " +
    entries.map(([key, child]) => key + ": " + formatValue(child)).join(", ");
}

function settingsSuffix(
  item: ApplyItemReport,
  value: unknown,
): string {
  if (item.status === "unchanged") {
    return "";
  }

  const changes = item.details.changes;
  if (Array.isArray(changes)) {
    return changes.length === 0 ? "" : " — " +
      changes.map((change) => {
        const entry = change as {
          readonly path: string;
          readonly before?: unknown;
          readonly beforeSet: boolean;
          readonly after: unknown;
        };
        return entry.path + ": " +
          (entry.beforeSet ? formatValue(entry.before) : "unset") +
          " → " + formatValue(entry.after);
      }).join(", ");
  }

  return formatSettingsSuffix(value);
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
  if (value === undefined) {
    return "unset";
  }

  if (Array.isArray(value)) {
    return "[" + value.map(formatValue).join(", ") + "]";
  }

  if (value === null) {
    return "blank";
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function statusSymbol(
  status:
    | RepositoryReport["status"]
    | ApplyItemReport["status"],
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
  readonly operations: {
    readonly planned: number;
    readonly applied: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly skippedBindings: number;
} {
  let unchanged = 0;
  let planned = 0;
  let applied = 0;
  let partiallyApplied = 0;
  let failed = 0;
  let plannedOperations = 0;
  let appliedOperations = 0;
  let failedOperations = 0;
  let skippedOperations = 0;

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
    for (const item of repository.items) {
      switch (item.status) {
        case "planned":
          plannedOperations++;
          break;
        case "applied":
          appliedOperations++;
          break;
        case "failed":
          failedOperations++;
          break;
        case "skipped":
          skippedOperations++;
          break;
      }
    }
  }

  const skippedBindings = groupRuntimeDiagnostics(report.repositories)
    .filter((group) => group.diagnostic.code.startsWith("skipped_"))
    .reduce((count, group) => count + diagnosticBindingCount(group), 0);

  return {
    unchanged,
    planned,
    applied,
    partiallyApplied,
    failed,
    operations: {
      planned: plannedOperations,
      applied: appliedOperations,
      failed: failedOperations,
      skipped: skippedOperations,
    },
    skippedBindings,
  };
}
