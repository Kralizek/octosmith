/** Values shared across OctoSmith's domain models. */

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
