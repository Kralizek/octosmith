import type { RepositoryCreationPreview } from "../configuration/creation_preview.ts";
import { renderRuntimeReferenceDiagnostic } from "../configuration/runtime_references.ts";

/** Render creation intent separately from ordinary reconciliation reports. */
export function renderRepositoryCreationPreview(
  preview: RepositoryCreationPreview,
): string {
  const lines = [
    "Repository creation preview (read-only)",
    "Configured owner: " + preview.owner,
    "Template: " + preview.template,
    "Status: " + (preview.ready ? "resolved" : "unresolved"),
  ];
  if (preview.identity !== undefined) {
    lines.push(
      "",
      "Resolved repository identity:",
      "  Name: " + preview.identity.name,
      "  Name origin: " + preview.identity.nameOrigin,
      "  " + preview.identity.nameNotice,
      "  Visibility: " + preview.identity.visibility,
    );
  } else {
    lines.push(
      "Name choice: " + preview.choices.name.status,
      ...preview.choices.name.alternatives.map(({ pattern }) =>
        "  Pattern: " + pattern
      ),
      "Visibility choice: " + preview.choices.visibility.status,
      "  Allowed: " + preview.choices.visibility.alternatives.join(", "),
    );
  }
  if (preview.requirements !== undefined) {
    lines.push(
      "",
      "Resolved creation requirements:",
      "  Teams: " + (preview.requirements.teams.join(", ") || "none"),
      "  Custom properties: " +
        JSON.stringify(preview.requirements.customProperties),
    );
  }
  if (preview.bootstrap !== undefined) {
    const branch = preview.bootstrap.defaultBranch;
    lines.push(
      "",
      "Bootstrap:",
      branch.status === "resolved"
        ? "  Default branch: " + branch.value + " (resolved from template)"
        : "  Default branch: deferred - " + branch.reason,
      "  Planned managed files: " + preview.bootstrap.plannedFileCount,
      ...preview.bootstrap.files.map((file) =>
        "  " + file.path + ": " + file.presence
      ),
      "  Post-create commands (before managed files): " +
        preview.bootstrap.postCreateCommandCount,
      ...preview.bootstrap.postCreateCommands.map(({ command }, index) =>
        "  " + (index + 1) + ". " + command + " (arguments omitted)"
      ),
      "",
      "GitHub-side desired resources (intent, not API deltas):",
      "  Collection management: " + preview.collectionManagement,
      "  Secret policy: " + preview.secretPolicy,
      ...preview.resources.map((resource) =>
        "  " + resource.category + ": " + resource.status +
        (resource.count === undefined ? "" : " (" + resource.count + ")") +
        (resource.fields.length
          ? "; fields: " + resource.fields.join(", ")
          : "") +
        (resource.targets.length
          ? "; targets: " + resource.targets.join(", ")
          : "") +
        (resource.secretCount === undefined
          ? ""
          : "; secrets: " + resource.secretCount) +
        (resource.variableCount === undefined
          ? ""
          : "; variables: " + resource.variableCount)
      ),
    );
  }
  if (preview.deferred.length) {
    lines.push(
      "",
      "Deferred until execution:",
      ...preview.deferred.map((item) => "  " + item.code + ": " + item.reason),
    );
  }
  if (preview.diagnostics.length || preview.validation.diagnostics.length) {
    lines.push(
      "",
      "Diagnostics:",
      ...preview.diagnostics.map((diagnostic) =>
        "  Error [" + diagnostic.code + "] " + diagnostic.message
      ),
      ...preview.validation.diagnostics.map((diagnostic) =>
        "  " + renderRuntimeReferenceDiagnostic(diagnostic)
      ),
    );
  }
  lines.push(
    "",
    "No repository was created and no bootstrap work was executed.",
  );
  return lines.join("\n");
}
