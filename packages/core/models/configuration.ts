import type {
  MergeMethod,
  PropertyValue,
  RulesetEnforcement,
  RulesetTarget,
} from "./common.ts";

export interface Configuration {
  readonly version: 1;
  readonly organization: string;
  readonly scope: RepositorySelector;
}

export interface RepositorySelector {
  readonly names?: readonly string[];
  readonly teams?: readonly string[];
  readonly properties?: Readonly<Record<string, PropertyValue>>;
}

export interface RepositoryTemplate {
  readonly match: RepositorySelector;
  readonly repository?: RepositoryConfiguration;
  readonly rulesets?: readonly RulesetConfiguration[];
  readonly environments?: readonly EnvironmentConfiguration[];
  readonly files?: Readonly<Record<string, FileConfiguration>>;
}

export interface RepositoryConfiguration {
  readonly settings?: RepositorySettingsConfiguration;
  readonly teams?: readonly TeamPermissionConfiguration[];
  readonly secrets?: readonly string[];
  readonly variables?: readonly string[];
}

export interface RepositorySettingsConfiguration {
  readonly hasWiki?: boolean;
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasDiscussions?: boolean;
  readonly deleteBranchOnMerge?: boolean;
  readonly merge?: MergeConfiguration;
}

export interface MergeConfiguration {
  readonly mergeCommit?: boolean;
  readonly rebase?: boolean;
  readonly squash?: boolean;
  readonly squashCommitTitle?: string;
}

export interface TeamPermissionConfiguration {
  readonly name: string;
  readonly permission: string;
}

export interface RulesetConfiguration {
  readonly name: string;
  readonly target: RulesetTarget;
  readonly enforcement: RulesetEnforcement;
  readonly conditions?: RulesetConditionsConfiguration;
  readonly rules: readonly RulesetRuleConfiguration[];
}

export interface RulesetConditionsConfiguration {
  readonly refName?: RefNameConditionConfiguration;
}

export interface RefNameConditionConfiguration {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export type RulesetRuleConfiguration =
  | { readonly type: "deletion" }
  | { readonly type: "non_fast_forward" }
  | {
    readonly type: "pull_request";
    readonly parameters: {
      readonly requiredReviewThreadResolution: boolean;
      readonly allowedMergeMethods: readonly MergeMethod[];
    };
  };

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
    readonly ensure: "absent";
  };
