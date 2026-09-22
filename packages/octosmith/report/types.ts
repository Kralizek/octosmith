import type { ApplyItemType, Operation } from "../plan/types.ts";

/** Describes repository report status. */
export type RepositoryReportStatus =
  | "unchanged"
  | "planned"
  | "applied"
  | "partially-applied"
  | "failed";

/** Describes apply item report status. */
export type ApplyItemReportStatus =
  | "unchanged"
  | "planned"
  | "applied"
  | "failed"
  | "skipped";

/** Describes report. */
export interface Report {
  readonly organization: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly repositories: readonly RepositoryReport[];
}

/** Describes repository report. */
export interface RepositoryReport {
  readonly repository: string;
  readonly template?: string;
  readonly status: RepositoryReportStatus;
  readonly items: readonly ApplyItemReport[];
  readonly error?: string;
}

/** Describes apply item report. */
export interface ApplyItemReport {
  readonly type: ApplyItemType;
  readonly status: ApplyItemReportStatus;
  readonly details: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

/** Describes applied operation result. */
export interface AppliedOperationLike {
  readonly operation: Operation;
  readonly status: "applied" | "failed" | "skipped";
  readonly error?: string;
}
