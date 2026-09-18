import type { Operation } from "../plan/types.ts";

export type RepositoryReportStatus =
  | "unchanged"
  | "planned"
  | "applied"
  | "partially-applied"
  | "failed";

export type OperationReportStatus =
  | "planned"
  | "applied"
  | "failed"
  | "skipped";

export interface Report {
  readonly organization: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly repositories: readonly RepositoryReport[];
}

export interface RepositoryReport {
  readonly repository: string;
  readonly template?: string;
  readonly status: RepositoryReportStatus;
  readonly operations: readonly OperationReport[];
  readonly error?: string;
}

export interface ReportedOperation {
  readonly type: Operation["type"];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface OperationReport {
  readonly operation: ReportedOperation;
  readonly status: OperationReportStatus;
  readonly error?: string;
}

export interface AppliedOperationLike {
  readonly operation: Operation;
  readonly status: "applied" | "failed" | "skipped";
  readonly error?: string;
}
