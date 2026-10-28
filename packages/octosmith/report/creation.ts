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
    ...(result.bootstrap
      ? [
        `Git bootstrap: ${result.bootstrap.outcome}`,
        `Branch: ${result.bootstrap.branch || "unresolved"}`,
        `Bootstrap file count: ${result.bootstrap.fileCount}`,
        `Prepared: ${result.bootstrap.prepared}`,
        `Initial commit created: ${result.bootstrap.commitCreated}`,
        ...(result.bootstrap.commitSha
          ? [`Initial commit: ${result.bootstrap.commitSha}`]
          : []),
        `Push attempted: ${result.bootstrap.pushAttempted}`,
        `Push confirmed: ${result.bootstrap.pushConfirmed}`,
        ...(result.bootstrap.failure
          ? [`Bootstrap failure: ${result.bootstrap.failure}`]
          : []),
        ...(result.bootstrap.cleanupFailed
          ? [
            "Temporary workspace cleanup failed; inspect local temporary storage.",
          ]
          : []),
      ]
      : []),
    `Deferred reconciliation attempted: ${result.deferredReconciliationAttempted}`,
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
        "Complete or verify Git bootstrap, then re-read current state and build a fresh GitHub-only plan; completed operations are not replayed.",
      ]
      : []),
    ...(result.report
      ? ["", "Pre-bootstrap reconciliation:", renderReport(result.report)]
      : []),
    ...(result.deferredReport
      ? [
        "",
        "Post-bootstrap reconciliation:",
        renderReport(result.deferredReport),
      ]
      : []),
  ];
  return lines.join("\n");
}
