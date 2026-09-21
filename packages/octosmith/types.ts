/** Values shared across OctoSmith's core concepts. */

export type PropertyValue = string | boolean | readonly string[];

/** Describes collection management mode. */
export type CollectionManagementMode = "explicit" | "strict";

/** Describes built in repository permission. */
export type BuiltInRepositoryPermission =
  | "pull"
  | "triage"
  | "push"
  | "maintain"
  | "admin";

/** Describes repository permission. */
export type RepositoryPermission =
  | { readonly kind: "built-in"; readonly name: BuiltInRepositoryPermission }
  | { readonly kind: "custom"; readonly name: string };

/** Describes team permission. */
export interface TeamPermission {
  readonly team: string;
  readonly permission: RepositoryPermission;
}

/** Describes merge method. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** Describes secret name. */
export type SecretName = string;

/** Describes desired secret. */
export interface DesiredSecret {
  readonly name: SecretName;
  readonly source: string;
}

/** Describes variable. */
export interface Variable {
  readonly name: string;
  readonly value: string;
}

/** Describes environment. */
export interface Environment {
  readonly name: string;
  readonly secrets: readonly SecretName[];
  readonly variables: readonly Variable[];
}

/** Describes repository visibility. */
export type RepositoryVisibility = "public" | "private" | "internal";

/** Describes pull request creation policy. */
export type PullRequestCreationPolicy = "all" | "collaborators-only";

/** Describes squash merge commit title. */
export type SquashMergeCommitTitle =
  | "pull-request-title"
  | "commit-or-pull-request-title";

/** Describes squash merge commit message. */
export type SquashMergeCommitMessage =
  | "pull-request-body"
  | "commit-messages"
  | "blank";

/** Describes merge commit title. */
export type MergeCommitTitle = "pull-request-title" | "merge-message";

/** Describes merge commit message. */
export type MergeCommitMessage =
  | "pull-request-title"
  | "pull-request-body"
  | "blank";

/** Describes security feature status. */
export type SecurityFeatureStatus = "enabled" | "disabled";

/** Describes ruleset target. */
export type RulesetTarget = "branch" | "tag" | "push";

/** Describes ruleset enforcement. */
export type RulesetEnforcement = "disabled" | "evaluate" | "active";

/** Describes ruleset bypass mode. */
export type RulesetBypassMode = "always" | "pull-request" | "exempt";

/** Describes ruleset bypass actor type. */
export type RulesetBypassActorType =
  | "integration"
  | "organization-admin"
  | "repository-role"
  | "team"
  | "deploy-key"
  | "user";
