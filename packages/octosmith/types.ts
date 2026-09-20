/** Values shared across OctoSmith's core concepts. */

export type PropertyValue = string | boolean | readonly string[];

export type CollectionManagementMode = "explicit" | "strict";

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

export type SecretName = string;

export interface DesiredSecret {
  readonly name: SecretName;
  readonly source: string;
}

export interface Variable {
  readonly name: string;
  readonly value: string;
}

export interface Environment {
  readonly name: string;
  readonly secrets: readonly SecretName[];
  readonly variables: readonly Variable[];
}

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
