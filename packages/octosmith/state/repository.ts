import type {
  MergeCommitMessage,
  MergeCommitTitle,
  PullRequestCreationPolicy,
  RepositoryVisibility,
  SecurityFeatureStatus,
  SquashMergeCommitMessage,
  SquashMergeCommitTitle,
} from "../types.ts";

/** Describes current security and analysis. */
export interface CurrentSecurityAndAnalysis {
  readonly advancedSecurity?: SecurityFeatureStatus;
  readonly codeSecurity?: SecurityFeatureStatus;
  readonly secretScanning?: SecurityFeatureStatus;
  readonly secretScanningPushProtection?: SecurityFeatureStatus;
  readonly secretScanningAiDetection?: SecurityFeatureStatus;
}

/** Describes desired security and analysis. */
export interface DesiredSecurityAndAnalysis {
  readonly advancedSecurity?: SecurityFeatureStatus;
  readonly codeSecurity?: SecurityFeatureStatus;
  readonly secretScanning?: SecurityFeatureStatus;
  readonly secretScanningPushProtection?: SecurityFeatureStatus;
  readonly secretScanningAiDetection?: SecurityFeatureStatus;
}

/** Describes current merge settings. */
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

/** Describes desired merge settings. */
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

/** Describes current repository settings. */
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

/** Describes desired repository settings. */
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
