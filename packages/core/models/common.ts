/** Values shared by configuration, state, planning, and reporting models. */

export type PropertyValue = string | boolean | readonly string[];

export type BuiltInRepositoryPermission =
  | "pull"
  | "triage"
  | "push"
  | "maintain"
  | "admin";

export type RepositoryPermission =
  | { readonly kind: "built-in"; readonly name: BuiltInRepositoryPermission }
  | { readonly kind: "custom"; readonly name: string };

export interface TeamPermission {
  readonly team: string;
  readonly permission: RepositoryPermission;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export type RulesetTarget = "branch" | "tag";

export type RulesetEnforcement = "disabled" | "evaluate" | "active";

export interface RefNameCondition {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface RulesetConditions {
  readonly refName?: RefNameCondition;
}

export interface DeletionRule {
  readonly type: "deletion";
}

export interface NonFastForwardRule {
  readonly type: "non-fast-forward";
}

export interface PullRequestRule {
  readonly type: "pull-request";
  readonly requiredReviewThreadResolution: boolean;
  readonly allowedMergeMethods: readonly MergeMethod[];
}

export type RulesetRule =
  | DeletionRule
  | NonFastForwardRule
  | PullRequestRule;

export interface Ruleset {
  readonly name: string;
  readonly target: RulesetTarget;
  readonly enforcement: RulesetEnforcement;
  readonly conditions?: RulesetConditions;
  readonly rules: readonly RulesetRule[];
}

export type SecretName = string;

export interface Variable {
  readonly name: string;
  readonly value: string;
}

export interface Environment {
  readonly name: string;
  readonly secrets: readonly SecretName[];
  readonly variables: readonly Variable[];
}
