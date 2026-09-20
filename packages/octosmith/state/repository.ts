import type {
  MergeCommitMessage,
  MergeCommitTitle,
  PullRequestCreationPolicy,
  RepositoryVisibility,
  SecurityFeatureStatus,
  SquashMergeCommitMessage,
  SquashMergeCommitTitle,
} from "../types.ts";

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
