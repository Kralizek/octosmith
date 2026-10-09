import type { ManagedFileSnapshot, Operation, Plan } from "../mod.ts";
import type { PullRequestResult } from "../report/types.ts";
import { assertPersistedOperationsExecutable } from "../plan/operation_contract.ts";

/** Describes apply operation status. */
export type ApplyOperationStatus = "applied" | "failed" | "skipped";

/** Describes apply operation result. */
export interface ApplyOperationResult {
  readonly operation: Operation;
  readonly status: ApplyOperationStatus;
  readonly error?: string;
}

/** Describes apply plan result. */
export interface ApplyPlanResult {
  readonly repository: string;
  readonly operations: readonly ApplyOperationResult[];
  readonly pullRequests?: readonly PullRequestResult[];
  readonly error?: string;
}

/** Describes apply plan options. */
export interface ApplyPlanOptions {
  readonly continueOnError?: boolean;
  readonly onPullRequest?: (result: PullRequestResult) => void | Promise<void>;
}

/** Describes repository mutation sink. */
export interface RepositoryMutationSink {
  readonly pullRequests?: readonly PullRequestResult[];
  onPullRequest?: (result: PullRequestResult) => void | Promise<void>;
  prepare?(
    repository: string,
    operations: readonly Operation[],
    fileBranch?: string,
    managedFiles?: ManagedFileSnapshot,
  ): RepositoryMutationSink | Promise<RepositoryMutationSink>;
  apply(repository: string, operation: Operation): Promise<void>;
  finish?(repository: string): Promise<void>;
}

/** Apply every operation in a plan through the configured mutation sink. */
export async function applyPlan(
  sink: RepositoryMutationSink,
  plan: Plan,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
  assertPersistedOperationsExecutable(plan.operations);
  const preparedSink = sink.prepare
    ? await sink.prepare(
      plan.repository,
      plan.operations,
      undefined,
      plan.managedFiles,
    )
    : sink;
  preparedSink.onPullRequest = options.onPullRequest;
  const results: ApplyOperationResult[] = [];
  let failed = false;

  for (const operation of plan.operations) {
    if (failed && !options.continueOnError) {
      results.push({
        operation,
        status: "skipped",
      });
      continue;
    }

    try {
      await preparedSink.apply(plan.repository, operation);
      results.push({
        operation,
        status: "applied",
      });
    } catch (error) {
      failed = true;
      results.push({
        operation,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let finishError: string | undefined;
  if (!failed && preparedSink.finish) {
    try {
      await preparedSink.finish(plan.repository);
    } catch (error) {
      finishError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    repository: plan.repository,
    operations: results,
    ...(preparedSink.pullRequests !== undefined &&
      preparedSink.pullRequests.length > 0 && {
      pullRequests: preparedSink.pullRequests,
    }),
    ...(finishError !== undefined && { error: finishError }),
  };
}
