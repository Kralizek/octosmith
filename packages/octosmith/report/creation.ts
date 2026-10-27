import type { RepositoryCreationResult } from "../creation.ts";
import { renderReport } from "./render.ts";

/** Render lifecycle stages separately from the ordinary reconciliation report. */
export function renderRepositoryCreationResult(
  result: RepositoryCreationResult,
): string {
  const lines = [
    `Repository creation: ${result.status}`,
    ...(result.repository
      ? [
        `Repository: ${result.repository.fullName}`,
        `URL: ${result.repository.url}`,
      ]
      : result.requestedName
      ? [`Requested repository: ${result.organization}/${result.requestedName}`]
      : []),
    `Completed stages: ${result.completedStages.join(", ") || "none"}`,
    ...result.metadataAssignments.map((assignment) =>
      `Metadata ${assignment.kind} ${assignment.target}: ${assignment.status}`
    ),
    ...(result.failedStage ? [`Failed stage: ${result.failedStage}`] : []),
    ...(result.error ? [result.error.message] : []),
    ...(result.specification?.diagnostics.map((diagnostic) =>
      `${diagnostic.code}: ${diagnostic.message}`
    ) ?? []),
    ...(result.recovery ? [`Recovery: ${result.recovery}`] : []),
    ...result.deferred.map((work) =>
      `Deferred ${work.resource} (${work.targets.join(", ")}): ${work.reason}`
    ),
    ...(result.deferred.length
      ? [
        "After #111 bootstrap, re-read current state and build a fresh GitHub-only plan; completed operations are not replayed.",
      ]
      : []),
    ...(result.report ? ["", renderReport(result.report)] : []),
  ];
  return lines.join("\n");
}
