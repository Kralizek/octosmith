import type {
  CollectionReconciliationMode,
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

export interface Configuration {
  readonly version: 1;
  readonly organization: string;
  readonly repositories: RepositoriesConfiguration;
  readonly settings?: SettingsConfiguration;
}

export interface RepositoriesConfiguration {
  readonly scope: RepositorySelector;
}

export interface SettingsConfiguration {
  readonly collectionManagement?: CollectionReconciliationMode;
}

export interface RepositorySelector {
  readonly names?: readonly string[];
  readonly teams?: readonly string[];
  readonly visibility?: RepositoryVisibility | readonly RepositoryVisibility[];
  readonly properties?: Readonly<Record<string, PropertyValue>>;
}

export interface RepositoryTemplate {
  readonly kind: "repository";
  readonly match: RepositorySelector;
  readonly repository: RepositoryConfiguration;
}

export interface RepositoryConfiguration {
  readonly settings?: RepositorySettingsConfiguration;
  readonly customProperties?: Readonly<
    Record<string, string | readonly string[] | null>
  >;
  readonly actions?: ActionsConfiguration;
  readonly teams?: readonly TeamPermissionConfiguration[];
  readonly secrets?: readonly string[];
  readonly variables?: readonly string[];
  readonly rulesets?: readonly RulesetConfiguration[];
  readonly environments?: readonly EnvironmentConfiguration[];
  readonly files?: Readonly<Record<string, FileConfiguration>>;
}

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

export interface SecurityAndAnalysisConfiguration {
  readonly advancedSecurity?: SecurityFeatureStatus;
  readonly codeSecurity?: SecurityFeatureStatus;
  readonly secretScanning?: SecurityFeatureStatus;
  readonly secretScanningPushProtection?: SecurityFeatureStatus;
  readonly secretScanningAiDetection?: SecurityFeatureStatus;
}

export interface ActionsConfiguration {
  readonly enabled?: boolean;
  readonly allowedActions?: "all" | "local_only" | "selected";
  readonly shaPinningRequired?: boolean;
  readonly selectedActions?: SelectedActionsConfiguration;
  readonly oidc?: ActionsOidcConfiguration;
}

export interface SelectedActionsConfiguration {
  readonly githubOwnedAllowed?: boolean;
  readonly verifiedAllowed?: boolean;
  readonly patternsAllowed?: readonly string[];
}

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

export interface ActionsOidcConfiguration {
  readonly subjectClaimTemplate?: SubjectClaimTemplateConfiguration;
  readonly immutableSubject?: boolean;
}

export interface TeamPermissionConfiguration {
  readonly name: string;
  readonly permission: string;
}

export interface RulesetConfiguration {
  readonly name: string;
  readonly target?: RulesetTarget;
  readonly enforcement?: RulesetEnforcement;
  readonly bypassActors?: readonly RulesetBypassActorConfiguration[];
  readonly conditions?: RulesetConditionsConfiguration;
  readonly rules?: readonly RulesetRuleConfiguration[];
}

export interface RulesetBypassActorConfiguration {
  readonly actorType: RulesetBypassActorType;
  readonly actorId?: number;
  readonly bypassMode: RulesetBypassMode;
}

export interface RulesetConditionsConfiguration {
  readonly refName?: RefNameConditionConfiguration;
}

export interface RefNameConditionConfiguration {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

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

export interface RulesetRuleConfiguration {
  readonly type: RulesetRuleTypeConfiguration;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface EnvironmentConfiguration {
  readonly name: string;
  readonly secrets?: readonly string[];
  readonly variables?: readonly string[];
}

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
