import type {
  CollectionManagementMode,
  MergeCommitMessage,
  MergeCommitTitle,
  PropertyValue,
  RepositoryVisibility,
  RulesetBypassActorType,
  RulesetBypassMode,
  RulesetEnforcement,
  RulesetTarget,
  SecurityFeatureStatus,
  SquashMergeCommitMessage,
  SquashMergeCommitTitle,
} from "../types.ts";

/** Describes configuration. */
export interface Configuration {
  readonly version: 1;
  readonly organization: string;
  readonly repositories: RepositoriesConfiguration;
}

/** Describes repositories configuration. */
export interface RepositoriesConfiguration {
  readonly scope: RepositorySelector;
  readonly settings?: RepositoryManagementSettings;
  readonly fileChanges?: FileChangesConfiguration;
}

/** Describes commit customization for managed file changes. */
export interface FileChangesCommitConfiguration {
  readonly message?: string;
}

/** Describes pull request customization for managed file changes. */
export interface FileChangesPullRequestConfiguration {
  readonly branchPrefix?: string;
  readonly title?: string;
  readonly labels?: readonly string[];
}

/** Describes how managed file changes are delivered. */
export type FileChangesConfiguration =
  | {
    readonly mode: "pull_request";
    readonly commit?: FileChangesCommitConfiguration;
    readonly pullRequest?: FileChangesPullRequestConfiguration;
  }
  | {
    readonly mode: "direct";
    readonly commit?: FileChangesCommitConfiguration;
  };

/** Describes repository management settings. */
export interface RepositoryManagementSettings {
  readonly collectionManagement?: CollectionManagementMode;
  readonly unmatchedRepositories?: "error" | "ignore";
}

/** Describes repository selector. */
export interface RepositorySelector {
  readonly names?: readonly string[];
  readonly teams?: readonly string[];
  readonly visibility?: RepositoryVisibility | readonly RepositoryVisibility[];
  readonly properties?: Readonly<Record<string, PropertyValue>>;
}

/** Describes repository template. */
export interface RepositoryTemplate {
  readonly kind: "repository";
  readonly match: RepositorySelector;
  readonly repository: RepositoryConfiguration;
}

/** Describes repository configuration. */
export interface RepositoryConfiguration {
  readonly settings?: RepositorySettingsConfiguration;
  readonly customProperties?: Readonly<
    Record<string, string | readonly string[] | null>
  >;
  readonly actions?: ActionsConfiguration;
  readonly dependabot?: DependabotConfiguration;
  readonly teams?: readonly TeamPermissionConfiguration[];
  readonly rulesets?: readonly RulesetConfiguration[];
  readonly environments?: readonly EnvironmentConfiguration[];
  readonly files?: Readonly<Record<string, FileConfiguration>>;
}

/** Describes repository settings configuration. */
export interface RepositorySettingsConfiguration {
  readonly description?: string | null;
  readonly website?: string | null;
  readonly topics?: readonly string[];
  readonly visibility?: RepositoryVisibility;
  readonly hasWiki?: boolean;
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasDiscussions?: boolean;
  readonly hasPullRequests?: boolean;
  readonly pullRequestCreationPolicy?: "all" | "collaborators_only";
  readonly isTemplate?: boolean;
  readonly defaultBranch?: string;
  readonly deleteBranchOnMerge?: boolean;
  readonly allowForking?: boolean;
  readonly archived?: boolean;
  readonly webCommitSignoffRequired?: boolean;
  readonly merge?: MergeConfiguration;
  readonly securityAndAnalysis?: SecurityAndAnalysisConfiguration;
}

/** Describes merge configuration. */
export interface MergeConfiguration {
  readonly squash?: boolean;
  readonly mergeCommit?: boolean;
  readonly rebase?: boolean;
  readonly autoMerge?: boolean;
  readonly updateBranch?: boolean;
  readonly squashCommitTitle?: SquashMergeCommitTitle;
  readonly squashCommitMessage?: SquashMergeCommitMessage;
  readonly mergeCommitTitle?: MergeCommitTitle;
  readonly mergeCommitMessage?: MergeCommitMessage;
}

/** Describes security and analysis configuration. */
export interface SecurityAndAnalysisConfiguration {
  readonly advancedSecurity?: SecurityFeatureStatus;
  readonly codeSecurity?: SecurityFeatureStatus;
  readonly secretScanning?: SecurityFeatureStatus;
  readonly secretScanningPushProtection?: SecurityFeatureStatus;
  readonly secretScanningAiDetection?: SecurityFeatureStatus;
}

/** Describes secret configuration. */
export type SecretConfiguration =
  | string
  | {
    readonly from: string;
    readonly to: string;
  };

/** Describes variable configuration. */
export type VariableConfiguration =
  | string
  | {
    readonly from: string;
    readonly to: string;
  }
  | {
    readonly name: string;
    readonly value: string;
  };

/** Describes actions configuration. */
export interface ActionsConfiguration {
  readonly secrets?: readonly SecretConfiguration[];
  readonly variables?: readonly VariableConfiguration[];
  readonly enabled?: boolean;
  readonly allowedActions?: "all" | "local_only" | "selected";
  readonly shaPinningRequired?: boolean;
  readonly selectedActions?: SelectedActionsConfiguration;
  readonly oidc?: ActionsOidcConfiguration;
}

/** Describes dependabot configuration. */
export interface DependabotConfiguration {
  readonly secrets?: readonly SecretConfiguration[];
}

/** Describes selected actions configuration. */
export interface SelectedActionsConfiguration {
  readonly githubOwnedAllowed?: boolean;
  readonly verifiedAllowed?: boolean;
  readonly patternsAllowed?: readonly string[];
}

/** Describes subject claim template configuration. */
export type SubjectClaimTemplateConfiguration =
  | {
    readonly source: "default";
  }
  | {
    readonly source: "organization";
  }
  | {
    readonly source: "custom";
    readonly claims: readonly string[];
  };

/** Describes actions OIDC configuration. */
export interface ActionsOidcConfiguration {
  readonly subjectClaimTemplate?: SubjectClaimTemplateConfiguration;
  readonly immutableSubject?: boolean;
}

/** Describes team permission configuration. */
export interface TeamPermissionConfiguration {
  readonly name: string;
  readonly permission: string;
}

/** Describes ruleset configuration. */
export interface RulesetConfiguration {
  readonly name: string;
  readonly target?: RulesetTarget;
  readonly enforcement?: RulesetEnforcement;
  readonly bypassActors?: readonly RulesetBypassActorConfiguration[];
  readonly conditions?: RulesetConditionsConfiguration;
  readonly rules?: readonly RulesetRuleConfiguration[];
}

/** Describes ruleset bypass actor configuration. */
export interface RulesetBypassActorConfiguration {
  readonly actorType: RulesetBypassActorType;
  readonly actorId?: number;
  readonly bypassMode: RulesetBypassMode;
}

/** Describes ruleset conditions configuration. */
export interface RulesetConditionsConfiguration {
  readonly refName?: RefNameConditionConfiguration;
}

/** Describes ref name condition configuration. */
export interface RefNameConditionConfiguration {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

/** Describes ruleset rule type configuration. */
export type RulesetRuleTypeConfiguration =
  | "creation"
  | "update"
  | "deletion"
  | "required_linear_history"
  | "merge_queue"
  | "required_deployments"
  | "required_signatures"
  | "pull_request"
  | "required_status_checks"
  | "non_fast_forward"
  | "commit_message_pattern"
  | "commit_author_email_pattern"
  | "committer_email_pattern"
  | "branch_name_pattern"
  | "tag_name_pattern"
  | "workflows"
  | "code_scanning"
  | "code_quality"
  | "code_coverage"
  | "copilot_code_review"
  | "license_compliance_scanning"
  | "file_path_restriction"
  | "max_file_path_length"
  | "file_extension_restriction"
  | "max_file_size";

/** Describes ruleset rule configuration. */
export interface RulesetRuleConfiguration {
  readonly type: RulesetRuleTypeConfiguration;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** Describes environment configuration. */
export interface EnvironmentConfiguration {
  readonly name: string;
  readonly secrets?: readonly SecretConfiguration[];
  readonly variables?: readonly VariableConfiguration[];
}

/** Describes file configuration. */
export type FileConfiguration =
  | {
    readonly ensure: "exact";
    readonly source: string;
  }
  | {
    readonly ensure: "exists";
    readonly source: string;
  }
  | {
    readonly ensure: "absent";
  };
