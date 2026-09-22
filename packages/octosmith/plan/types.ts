import type {
  CollectionManagementMode,
  DesiredSecret,
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

/** Describes plan. */
export interface Plan {
  readonly repository: string;
  readonly operations: readonly Operation[];
}

/** Describes apply item type. */
export type ApplyItemType =
  | "repository-settings"
  | "custom-property"
  | "actions-settings"
  | "actions-oidc"
  | "actions-variable"
  | "actions-secret"
  | "dependabot-secret"
  | "team-permission"
  | "ruleset"
  | "environment"
  | "file";

/** Describes apply evaluation. */
export interface ApplyEvaluation {
  readonly type: ApplyItemType;
  readonly details: Readonly<Record<string, unknown>>;
  readonly operation?: Operation;
}

/** Describes operation. */
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

/** Describes update repository settings operation. */
export interface UpdateRepositorySettingsOperation {
  readonly type: "update-repository-settings";
  readonly settings: DesiredRepositorySettings;
}

/** Describes set custom property operation. */
export interface SetCustomPropertyOperation {
  readonly type: "set-custom-property";
  readonly name: string;
  readonly value: CustomPropertyValue;
}

/** Describes update actions settings operation. */
export interface UpdateActionsSettingsOperation {
  readonly type: "update-actions-settings";
  readonly settings: DesiredActionsSettings;
}

/** Describes update actions OIDC settings operation. */
export interface UpdateActionsOidcSettingsOperation {
  readonly type: "update-actions-oidc";
  readonly settings: DesiredActionsOidcSettings;
}

/** Describes set team permission operation. */
export interface SetTeamPermissionOperation {
  readonly type: "set-team-permission";
  readonly permission: TeamPermission;
}

/** Describes remove team permission operation. */
export interface RemoveTeamPermissionOperation {
  readonly type: "remove-team-permission";
  readonly team: string;
}

/** Describes set actions variable operation. */
export interface SetActionsVariableOperation {
  readonly type: "set-actions-variable";
  readonly variable: Variable;
}

/** Describes remove actions variable operation. */
export interface RemoveActionsVariableOperation {
  readonly type: "remove-actions-variable";
  readonly name: string;
}

/** Describes set actions secret operation. */
export interface SetActionsSecretOperation {
  readonly type: "set-actions-secret";
  readonly secret: DesiredSecret;
}

/** Describes remove actions secret operation. */
export interface RemoveActionsSecretOperation {
  readonly type: "remove-actions-secret";
  readonly secret: SecretName;
}

/** Describes set dependabot secret operation. */
export interface SetDependabotSecretOperation {
  readonly type: "set-dependabot-secret";
  readonly secret: DesiredSecret;
}

/** Describes remove dependabot secret operation. */
export interface RemoveDependabotSecretOperation {
  readonly type: "remove-dependabot-secret";
  readonly secret: SecretName;
}

/** Describes create ruleset operation. */
export interface CreateRulesetOperation {
  readonly type: "create-ruleset";
  readonly ruleset: RulesetDefinition;
}

/** Describes update ruleset operation. */
export interface UpdateRulesetOperation {
  readonly type: "update-ruleset";
  readonly id: number;
  readonly changes: DesiredRuleset;
}

/** Describes delete ruleset operation. */
export interface DeleteRulesetOperation {
  readonly type: "delete-ruleset";
  readonly id: number;
  readonly name: string;
}

/** Describes create environment operation. */
export interface CreateEnvironmentOperation {
  readonly type: "create-environment";
  readonly environment: DesiredEnvironment;
}

/** Describes update environment operation. */
export interface UpdateEnvironmentOperation {
  readonly type: "update-environment";
  readonly environment: DesiredEnvironment;
  readonly collections: CollectionManagementMode;
}

/** Describes delete environment operation. */
export interface DeleteEnvironmentOperation {
  readonly type: "delete-environment";
  readonly name: string;
}

/** Describes create file operation. */
export interface CreateFileOperation {
  readonly type: "create-file";
  readonly file: Extract<DesiredFile, { readonly ensure: "exact" | "exists" }>;
}

/** Describes update file operation. */
export interface UpdateFileOperation {
  readonly type: "update-file";
  readonly sha: string;
  readonly file: Extract<DesiredFile, { readonly ensure: "exact" }>;
}

/** Describes delete file operation. */
export interface DeleteFileOperation {
  readonly type: "delete-file";
  readonly path: string;
  readonly sha: string;
}
