import type {
  MergeMethod,
  RulesetBypassActorType,
  RulesetBypassMode,
  RulesetEnforcement,
  RulesetTarget,
} from "../types.ts";

export type RulesetTarget = "branch" | "tag" | "push";

export type RulesetEnforcement = "disabled" | "evaluate" | "active";

export type RulesetBypassMode = "always" | "pull-request" | "exempt";

export type RulesetBypassActorType =
  | "integration"
  | "organization-admin"
  | "repository-role"
  | "team"
  | "deploy-key"
  | "user";

export interface RulesetBypassActor {
  readonly actorType: RulesetBypassActorType;
  readonly actorId?: number;
  readonly bypassMode: RulesetBypassMode;
}

export interface RefNameCondition {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export interface RefRulesetConditions {
  readonly refName: RefNameCondition;
}

export type PatternOperator =
  | "starts-with"
  | "ends-with"
  | "contains"
  | "regex";

export interface PatternParameters {
  readonly name?: string;
  readonly negate?: boolean;
  readonly operator: PatternOperator;
  readonly pattern: string;
}

export interface RequiredStatusCheck {
  readonly context: string;
  readonly integrationId?: number;
}

export interface RequiredWorkflow {
  readonly path: string;
  readonly repositoryId: number;
  readonly ref?: string;
  readonly sha?: string;
}

export interface CodeScanningTool {
  readonly tool: string;
  readonly alertsThreshold:
    | "none"
    | "errors"
    | "errors-and-warnings"
    | "all";
  readonly securityAlertsThreshold:
    | "none"
    | "critical"
    | "high-or-higher"
    | "medium-or-higher"
    | "all";
}

export interface PullRequestDismissalActor {
  readonly id: number;
  readonly type:
    | "user"
    | "team"
    | "integration-installation"
    | "repository-role";
}

export interface RequiredReviewer {
  readonly reviewerTeamId: number;
  readonly filePatterns: readonly string[];
  readonly minimumApprovals: number;
}

export type CurrentRefRule =
  | { readonly type: "creation" }
  | {
    readonly type: "update";
    readonly updateAllowsFetchAndMerge: boolean;
  }
  | { readonly type: "deletion" }
  | { readonly type: "required-linear-history" }
  | {
    readonly type: "merge-queue";
    readonly checkResponseTimeoutMinutes: number;
    readonly groupingStrategy: "all-green" | "head-green";
    readonly maxEntriesToBuild: number;
    readonly maxEntriesToMerge: number;
    readonly mergeMethod: MergeMethod;
    readonly minEntriesToMerge: number;
    readonly minEntriesToMergeWaitMinutes: number;
  }
  | {
    readonly type: "required-deployments";
    readonly environments: readonly string[];
  }
  | { readonly type: "required-signatures" }
  | {
    readonly type: "pull-request";
    readonly allowedMergeMethods: readonly MergeMethod[];
    readonly dismissStaleReviewsOnPush: boolean;
    readonly dismissalRestriction: {
      readonly enabled: boolean;
      readonly allowedActors: readonly PullRequestDismissalActor[];
    };
    readonly requireCodeOwnerReview: boolean;
    readonly requireLastPushApproval: boolean;
    readonly requiredApprovingReviewCount: number;
    readonly requiredReviewThreadResolution: boolean;
    readonly requiredReviewers: readonly RequiredReviewer[];
  }
  | {
    readonly type: "required-status-checks";
    readonly doNotEnforceOnCreate: boolean;
    readonly checks: readonly RequiredStatusCheck[];
    readonly strict: boolean;
  }
  | { readonly type: "non-fast-forward" }
  | ({ readonly type: "commit-message-pattern" } & PatternParameters)
  | ({ readonly type: "commit-author-email-pattern" } & PatternParameters)
  | ({ readonly type: "committer-email-pattern" } & PatternParameters)
  | ({ readonly type: "branch-name-pattern" } & PatternParameters)
  | ({ readonly type: "tag-name-pattern" } & PatternParameters)
  | {
    readonly type: "workflows";
    readonly doNotEnforceOnCreate: boolean;
    readonly workflows: readonly RequiredWorkflow[];
  }
  | {
    readonly type: "code-scanning";
    readonly tools: readonly CodeScanningTool[];
  }
  | {
    readonly type: "code-quality";
    readonly severity: "errors" | "warnings" | "notes" | "all";
  }
  | {
    readonly type: "code-coverage";
    readonly maxCoverageDrop?: number;
    readonly minimumCoverage?: number;
  }
  | {
    readonly type: "copilot-code-review";
    readonly reviewDraftPullRequests: boolean;
    readonly reviewOnPush: boolean;
  }
  | { readonly type: "license-compliance-scanning" };

export type CurrentPushRule =
  | {
    readonly type: "file-path-restriction";
    readonly restrictedFilePaths: readonly string[];
  }
  | {
    readonly type: "max-file-path-length";
    readonly maxFilePathLength: number;
  }
  | {
    readonly type: "file-extension-restriction";
    readonly restrictedFileExtensions: readonly string[];
  }
  | {
    readonly type: "max-file-size";
    readonly maxFileSizeMb: number;
  };

export interface RefRulesetDefinition {
  readonly name: string;
  readonly target: "branch" | "tag";
  readonly enforcement: RulesetEnforcement;
  readonly bypassActors: readonly RulesetBypassActor[];
  readonly conditions: RefRulesetConditions;
  readonly rules: readonly CurrentRefRule[];
}

export interface PushRulesetDefinition {
  readonly name: string;
  readonly target: "push";
  readonly enforcement: RulesetEnforcement;
  readonly bypassActors: readonly RulesetBypassActor[];
  readonly rules: readonly CurrentPushRule[];
}

export type RulesetDefinition = RefRulesetDefinition | PushRulesetDefinition;

export type CurrentRuleset =
  | (RefRulesetDefinition & { readonly id: number })
  | (PushRulesetDefinition & { readonly id: number });

type DeepPartial<T> = T extends readonly (infer Item)[]
  ? readonly DeepPartial<Item>[]
  : T extends object ? { readonly [Key in keyof T]?: DeepPartial<T[Key]> }
  : T;

type SparseRule<Rule extends { readonly type: string }> =
  & Pick<Rule, "type">
  & DeepPartial<Omit<Rule, "type">>;

export type DesiredRefRule = CurrentRefRule extends infer Rule
  ? Rule extends { readonly type: string } ? SparseRule<Rule> : never
  : never;

export type DesiredPushRule = CurrentPushRule extends infer Rule
  ? Rule extends { readonly type: string } ? SparseRule<Rule> : never
  : never;

export type DesiredRulesetRule = DesiredRefRule | DesiredPushRule;

/**
 * A sparse ownership declaration for a ruleset.
 *
 * Only fields present here are owned by OctoSmith. A planner may require more
 * information if the ruleset does not exist and must be created.
 */
export interface DesiredRuleset {
  readonly name: string;
  readonly target?: RulesetTarget;
  readonly enforcement?: RulesetEnforcement;
  readonly bypassActors?: readonly DeepPartial<RulesetBypassActor>[];
  readonly conditions?: DeepPartial<RefRulesetConditions>;
  readonly rules?: readonly DesiredRulesetRule[];
}
