import type {
  Operation,
  ReconciliationItemType,
} from "../plan/types.ts";

export type RepositoryReportStatus =
  | "unchanged"
  | "planned"
  | "applied"
  | "partially-applied"
  | "failed";

export type ReconciliationItemReportStatus =
  | "unchanged"
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
  readonly items: readonly ReconciliationItemReport[];
  readonly error?: string;
}

export interface ReconciliationItemReport {
  readonly type: ReconciliationItemType;
  readonly status: ReconciliationItemReportStatus;
  readonly details: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface AppliedOperationLike {
  readonly operation: Operation;
  readonly status: "applied" | "failed" | "skipped";
  readonly error?: string;
}
