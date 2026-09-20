import type { ApplyItemType, Operation } from "../plan/types.ts";

export type RepositoryReportStatus =
  | "unchanged"
  | "planned"
  | "applied"
  | "partially-applied"
  | "failed";

export type ApplyItemReportStatus =
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
  readonly items: readonly ApplyItemReport[];
  readonly error?: string;
}

export interface ApplyItemReport {
  readonly type: ApplyItemType;
  readonly status: ApplyItemReportStatus;
  readonly details: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface AppliedOperationLike {
  readonly operation: Operation;
  readonly status: "applied" | "failed" | "skipped";
  readonly error?: string;
}
