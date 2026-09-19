import type {
  CollectionReconciliationMode,
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
import type { DesiredEnvironment, DesiredFile } from "../state/types.ts";

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
  | SetActionsVariableOperation
  | RemoveActionsVariableOperation
  | SetActionsSecretOperation
  | RemoveActionsSecretOperation
  | SetDependabotSecretOperation
  | RemoveDependabotSecretOperation
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

export interface SetActionsVariableOperation {
  readonly type: "set-actions-variable";
  readonly variable: Variable;
}

export interface RemoveActionsVariableOperation {
  readonly type: "remove-actions-variable";
  readonly name: string;
}

export interface SetActionsSecretOperation {
  readonly type: "set-actions-secret";
  readonly secret: SecretName;
}

export interface RemoveActionsSecretOperation {
  readonly type: "remove-actions-secret";
  readonly secret: SecretName;
}

export interface SetDependabotSecretOperation {
  readonly type: "set-dependabot-secret";
  readonly secret: SecretName;
}

export interface RemoveDependabotSecretOperation {
  readonly type: "remove-dependabot-secret";
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
  readonly environment: DesiredEnvironment;
  readonly collections: CollectionReconciliationMode;
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
