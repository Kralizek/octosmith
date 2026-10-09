import {
  type RuntimeReferenceDiagnostic,
  RuntimeReferenceError,
  RuntimeReferenceProviderError,
} from "../configuration/runtime_references.ts";
import type { ApplyEvaluation, Plan } from "../plan/types.ts";
import type {
  AppliedOperationLike,
  ApplyItemReport,
  PullRequestResult,
  RepositoryReport,
} from "./types.ts";

/** Build a repository report for a planned change set. */
export function reportPlannedRepository(
  template: string,
  plan: Plan,
  evaluations: readonly ApplyEvaluation[],
  templateName?: string,
  diagnostics?: readonly RuntimeReferenceDiagnostic[],
): RepositoryReport {
  return {
    repository: plan.repository,
    template,
    ...(templateName !== undefined && { templateName }),
    status: plan.operations.length === 0 ? "unchanged" : "planned",
    items: evaluations.map((evaluation) => ({
      type: evaluation.type,
      status: evaluation.operation === undefined ? "unchanged" : "planned",
      details: evaluation.details,
    })),
    ...(diagnostics !== undefined && diagnostics.length > 0 && { diagnostics }),
  };
}

/** Build a repository report for an applied change set. */
export function reportAppliedRepository(
  template: string,
  repository: string,
  evaluations: readonly ApplyEvaluation[],
  operations: readonly AppliedOperationLike[],
  templateName?: string,
  diagnostics?: readonly RuntimeReferenceDiagnostic[],
  pullRequests?: readonly PullRequestResult[],
  error?: string,
): RepositoryReport {
  const applied = operations.filter((item) => item.status === "applied").length;
  const failed = error !== undefined ||
    operations.some((item) => item.status === "failed");
  const skipped = operations.some((item) => item.status === "skipped");

  if (skipped && !failed) {
    throw new Error("Skipped operations require a failed operation");
  }

  const outcomes = new Map(
    operations.map((item) => [item.operation, item] as const),
  );

  const items: ApplyItemReport[] = evaluations.map((evaluation) => {
    if (evaluation.operation === undefined) {
      return {
        type: evaluation.type,
        status: "unchanged",
        details: evaluation.details,
      };
    }

    const outcome = outcomes.get(evaluation.operation);

    if (!outcome) {
      throw new Error(
        "Missing apply outcome for operation: " + evaluation.operation.type,
      );
    }

    return {
      type: evaluation.type,
      status: outcome.status,
      details: evaluation.details,
      ...(outcome.error !== undefined && { error: outcome.error }),
    };
  });

  return {
    repository,
    template,
    ...(templateName !== undefined && { templateName }),
    status: failed
      ? applied > 0 || (pullRequests?.length ?? 0) > 0
        ? "partially-applied"
        : "failed"
      : operations.length === 0 && (pullRequests?.length ?? 0) === 0
      ? "unchanged"
      : "applied",
    items,
    ...(diagnostics !== undefined && diagnostics.length > 0 && { diagnostics }),
    ...(pullRequests !== undefined && pullRequests.length > 0 && {
      pullRequests: uniquePullRequests(pullRequests),
    }),
    ...(error !== undefined && { error }),
  };
}

/** Deduplicate successful lifecycle outcomes and order them deterministically. */
export function uniquePullRequests(
  pullRequests: readonly PullRequestResult[],
): readonly PullRequestResult[] {
  return [...new Map(
    pullRequests.map((pullRequest) => [
      pullRequest.repository + "#" + pullRequest.number + ":" +
      pullRequest.action,
      pullRequest,
    ]),
  ).values()].sort((left, right) =>
    left.repository < right.repository
      ? -1
      : left.repository > right.repository
      ? 1
      : left.number - right.number ||
        (left.action < right.action ? -1 : left.action > right.action ? 1 : 0)
  );
}

/** Build a repository report for a failed repository operation. */
export function reportFailedRepository(
  repository: string,
  error: unknown,
  template?: string,
  templateName?: string,
  diagnostics: readonly RuntimeReferenceDiagnostic[] = [],
  evaluations: readonly ApplyEvaluation[] = [],
): RepositoryReport {
  const allDiagnostics = [
    ...diagnostics,
    ...(
      error instanceof RuntimeReferenceError ||
        error instanceof RuntimeReferenceProviderError
        ? error.diagnostics
        : []
    ),
  ];

  return {
    repository,
    ...(template !== undefined && { template }),
    ...(templateName !== undefined && { templateName }),
    status: "failed",
    items: evaluations.map((evaluation) => ({
      type: evaluation.type,
      status: evaluation.operation === undefined ? "unchanged" : "skipped",
      details: evaluation.details,
    })),
    error: error instanceof Error ? error.message : String(error),
    ...(allDiagnostics.length > 0 && { diagnostics: allDiagnostics }),
  };
}
