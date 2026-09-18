export type RepositoryVisibility = "public" | "private" | "internal";

export type PullRequestCreationPolicy = "all" | "collaborators-only";

export type SquashMergeCommitTitle =
  | "pull-request-title"
  | "commit-or-pull-request-title";

export type SquashMergeCommitMessage =
  | "pull-request-body"
  | "commit-messages"
  | "blank";

export type MergeCommitTitle = "pull-request-title" | "merge-message";

export type MergeCommitMessage =
  | "pull-request-title"
  | "pull-request-body"
  | "blank";

export type SecurityFeatureStatus = "enabled" | "disabled";

export interface CurrentSecurityAndAnalysis {
  readonly advancedSecurity?: SecurityFeatureStatus;
  readonly codeSecurity?: SecurityFeatureStatus;
  readonly secretScanning?: SecurityFeatureStatus;
  readonly secretScanningPushProtection?: SecurityFeatureStatus;
  readonly secretScanningAiDetection?: SecurityFeatureStatus;
}

export interface DesiredSecurityAndAnalysis {
  readonly advancedSecurity?: SecurityFeatureStatus;
  readonly codeSecurity?: SecurityFeatureStatus;
  readonly secretScanning?: SecurityFeatureStatus;
  readonly secretScanningPushProtection?: SecurityFeatureStatus;
  readonly secretScanningAiDetection?: SecurityFeatureStatus;
}

export interface CurrentMergeSettings {
  readonly allowSquashMerge: boolean;
  readonly allowMergeCommit: boolean;
  readonly allowRebaseMerge: boolean;
  readonly allowAutoMerge: boolean;
  readonly allowUpdateBranch: boolean;
  readonly deleteBranchOnMerge: boolean;
  readonly squashMergeCommitTitle: SquashMergeCommitTitle;
  readonly squashMergeCommitMessage: SquashMergeCommitMessage;
  readonly mergeCommitTitle: MergeCommitTitle;
  readonly mergeCommitMessage: MergeCommitMessage;
}

export interface DesiredMergeSettings {
  readonly allowSquashMerge?: boolean;
  readonly allowMergeCommit?: boolean;
  readonly allowRebaseMerge?: boolean;
  readonly allowAutoMerge?: boolean;
  readonly allowUpdateBranch?: boolean;
  readonly deleteBranchOnMerge?: boolean;
  readonly squashMergeCommitTitle?: SquashMergeCommitTitle;
  readonly squashMergeCommitMessage?: SquashMergeCommitMessage;
  readonly mergeCommitTitle?: MergeCommitTitle;
  readonly mergeCommitMessage?: MergeCommitMessage;
}

export interface CurrentRepositorySettings {
  readonly name: string;
  readonly description: string | null;
  readonly website: string | null;
  readonly topics: readonly string[];
  readonly visibility: RepositoryVisibility;
  readonly hasIssues: boolean;
  readonly hasProjects: boolean;
  readonly hasWiki: boolean;
  readonly hasDiscussions: boolean;
  readonly hasPullRequests: boolean;
  readonly pullRequestCreationPolicy: PullRequestCreationPolicy;
  readonly isTemplate: boolean;
  readonly defaultBranch: string;
  readonly merge: CurrentMergeSettings;
  readonly archived: boolean;
  readonly allowForking: boolean;
  readonly webCommitSignoffRequired: boolean;
  readonly securityAndAnalysis: CurrentSecurityAndAnalysis;
}

export interface DesiredRepositorySettings {
  readonly description?: string | null;
  readonly website?: string | null;
  readonly topics?: readonly string[];
  readonly visibility?: RepositoryVisibility;
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasWiki?: boolean;
  readonly hasDiscussions?: boolean;
  readonly hasPullRequests?: boolean;
  readonly pullRequestCreationPolicy?: PullRequestCreationPolicy;
  readonly isTemplate?: boolean;
  readonly defaultBranch?: string;
  readonly merge?: DesiredMergeSettings;
  readonly archived?: boolean;
  readonly allowForking?: boolean;
  readonly webCommitSignoffRequired?: boolean;
  readonly securityAndAnalysis?: DesiredSecurityAndAnalysis;
}
