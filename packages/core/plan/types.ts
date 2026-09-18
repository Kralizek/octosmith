import type {
  Environment,
  SecretName,
  TeamPermission,
  Variable,
} from "../types.ts";
import type {
  CustomPropertyValue,
  DesiredActionsOidcSettings,
  DesiredActionsSettings,
} from "../state/resources.ts";
import type { DesiredRepositorySettings } from "../state/repository.ts";
import type { DesiredRuleset, RulesetDefinition } from "../state/rulesets.ts";
import type { DesiredFile } from "../state/types.ts";

export interface Plan {
  readonly repository: string;
  readonly operations: readonly Operation[];
}

export type Operation =
  | UpdateRepositorySettingsOperation
  | SetCustomPropertyOperation
  | UpdateActionsSettingsOperation
  | UpdateActionsOidcSettingsOperation
  | SetTeamPermissionOperation
  | RemoveTeamPermissionOperation
  | SetRepositoryVariableOperation
  | RemoveRepositoryVariableOperation
  | SetRepositorySecretOperation
  | RemoveRepositorySecretOperation
  | CreateRulesetOperation
  | UpdateRulesetOperation
  | DeleteRulesetOperation
  | CreateEnvironmentOperation
  | UpdateEnvironmentOperation
  | DeleteEnvironmentOperation
  | CreateFileOperation
  | UpdateFileOperation
  | DeleteFileOperation;

export interface UpdateRepositorySettingsOperation {
  readonly type: "update-repository-settings";
  readonly settings: DesiredRepositorySettings;
}

export interface SetCustomPropertyOperation {
  readonly type: "set-custom-property";
  readonly name: string;
  readonly value: CustomPropertyValue;
}

export interface UpdateActionsSettingsOperation {
  readonly type: "update-actions-settings";
  readonly settings: DesiredActionsSettings;
}

export interface UpdateActionsOidcSettingsOperation {
  readonly type: "update-actions-oidc";
  readonly settings: DesiredActionsOidcSettings;
}

export interface SetTeamPermissionOperation {
  readonly type: "set-team-permission";
  readonly permission: TeamPermission;
}

export interface RemoveTeamPermissionOperation {
  readonly type: "remove-team-permission";
  readonly team: string;
}

export interface SetRepositoryVariableOperation {
  readonly type: "set-repository-variable";
  readonly variable: Variable;
}

export interface RemoveRepositoryVariableOperation {
  readonly type: "remove-repository-variable";
  readonly name: string;
}

export interface SetRepositorySecretOperation {
  readonly type: "set-repository-secret";
  readonly secret: SecretName;
}

export interface RemoveRepositorySecretOperation {
  readonly type: "remove-repository-secret";
  readonly secret: SecretName;
}

export interface CreateRulesetOperation {
  readonly type: "create-ruleset";
  readonly ruleset: RulesetDefinition;
}

export interface UpdateRulesetOperation {
  readonly type: "update-ruleset";
  readonly id: number;
  readonly changes: DesiredRuleset;
}

export interface DeleteRulesetOperation {
  readonly type: "delete-ruleset";
  readonly id: number;
  readonly name: string;
}

export interface CreateEnvironmentOperation {
  readonly type: "create-environment";
  readonly environment: Environment;
}

export interface UpdateEnvironmentOperation {
  readonly type: "update-environment";
  readonly environment: Environment;
}

export interface DeleteEnvironmentOperation {
  readonly type: "delete-environment";
  readonly name: string;
}

export interface CreateFileOperation {
  readonly type: "create-file";
  readonly file: Extract<DesiredFile, { readonly ensure: "exact" | "exists" }>;
}

export interface UpdateFileOperation {
  readonly type: "update-file";
  readonly sha: string;
  readonly file: Extract<DesiredFile, { readonly ensure: "exact" }>;
}

export interface DeleteFileOperation {
  readonly type: "delete-file";
  readonly path: string;
  readonly sha: string;
}
