import type { Operation } from "./plan.ts";

export type RepositoryReportStatus =
  | "unchanged"
  | "planned"
  | "applied"
  | "partially-applied"
  | "failed";

export type OperationReportStatus = "planned" | "applied" | "failed";

export interface Report {
  readonly organization: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly repositories: readonly RepositoryReport[];
}

export interface RepositoryReport {
  readonly repository: string;
  readonly template: string;
  readonly status: RepositoryReportStatus;
  readonly operations: readonly OperationReport[];
}

export interface OperationReport {
  readonly operation: Operation;
  readonly status: OperationReportStatus;
  readonly error?: string;
}
