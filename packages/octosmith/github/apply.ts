import type { Operation, Plan } from "../mod.ts";

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
}

/** Describes apply plan options. */
export interface ApplyPlanOptions {
  readonly continueOnError?: boolean;
}

/** Describes repository mutation sink. */
export interface RepositoryMutationSink {
  prepare?(
    repository: string,
    operations: readonly Operation[],
  ): RepositoryMutationSink | Promise<RepositoryMutationSink>;
  apply(repository: string, operation: Operation): Promise<void>;
}

export async function applyPlan(
  sink: RepositoryMutationSink,
  plan: Plan,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
  const preparedSink = sink.prepare
    ? await sink.prepare(plan.repository, plan.operations)
    : sink;
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

  return {
    repository: plan.repository,
    operations: results,
  };
}
