import type { DesiredSecret, SecretName, Variable } from "../types.ts";

/** Describes custom property value. */
export type CustomPropertyValue =
  | string
  | readonly string[]
  | null;

/** Describes actions allowed actions. */
export type ActionsAllowedActions = "all" | "local-only" | "selected";

/** Describes current selected actions. */
export interface CurrentSelectedActions {
  readonly githubOwnedAllowed: boolean;
  readonly verifiedAllowed: boolean;
  readonly patternsAllowed: readonly string[];
}

/** Describes desired selected actions. */
export interface DesiredSelectedActions {
  readonly githubOwnedAllowed?: boolean;
  readonly verifiedAllowed?: boolean;
  readonly patternsAllowed?: readonly string[];
}

/** Describes subject claim template. */
export type SubjectClaimTemplate =
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

/** Describes current actions OIDC settings. */
export interface CurrentActionsOidcSettings {
  readonly subjectClaimTemplate: SubjectClaimTemplate;
  readonly immutableSubject: boolean;
}

/** Describes desired actions OIDC settings. */
export interface DesiredActionsOidcSettings {
  readonly subjectClaimTemplate?: SubjectClaimTemplate;
  readonly immutableSubject?: boolean;
}

/** Describes current actions settings. */
export interface CurrentActionsSettings {
  readonly enabled: boolean;
  readonly allowedActions: ActionsAllowedActions;
  readonly shaPinningRequired: boolean;
  readonly selectedActions?: CurrentSelectedActions;
  readonly oidc: CurrentActionsOidcSettings;
}

/** Describes desired actions settings. */
export interface DesiredActionsSettings {
  readonly enabled?: boolean;
  readonly allowedActions?: ActionsAllowedActions;
  readonly shaPinningRequired?: boolean;
  readonly selectedActions?: DesiredSelectedActions;
  readonly oidc?: DesiredActionsOidcSettings;
}

/** Describes current actions. */
export interface CurrentActions extends CurrentActionsSettings {
  readonly secrets: readonly SecretName[];
  readonly variables: readonly Variable[];
}

/** Describes desired actions. */
export interface DesiredActions extends DesiredActionsSettings {
  readonly secrets?: readonly DesiredSecret[];
  readonly variables?: readonly Variable[];
}

/** Describes current dependabot. */
export interface CurrentDependabot {
  readonly secrets: readonly SecretName[];
}

/** Describes desired dependabot. */
export interface DesiredDependabot {
  readonly secrets?: readonly DesiredSecret[];
}

/** Describes copilot enabled tools. */
export interface CopilotEnabledTools {
  readonly codeql: boolean;
  readonly copilotCodeReview: boolean;
  readonly secretScanning: boolean;
  readonly dependencyVulnerabilityChecks: boolean;
}

/** Describes current copilot MCP settings. */
export interface CurrentCopilotMcpSettings {
  readonly configuration: unknown | null;
}

/** Describes current copilot internet access settings. */
export interface CurrentCopilotInternetAccessSettings {
  readonly firewallEnabled: boolean;
  readonly recommendedAllowlistEnabled: boolean;
  readonly customAllowlist: readonly string[];
}

/**
 * Repository-level Copilot cloud-agent settings currently exposed by GitHub.
 *
 * MCP configuration is shared by Copilot cloud agent and code review.
 * GitHub's public repository API currently exposes this configuration as
 * read-only, so Octosmith does not model a desired counterpart yet.
 */
export interface CurrentCopilotSettings {
  readonly mcp: CurrentCopilotMcpSettings;
  readonly internetAccess: CurrentCopilotInternetAccessSettings;
  readonly enabledTools: CopilotEnabledTools;
  readonly requireActionsWorkflowApproval: boolean;
  readonly automationsEnabled: boolean;
  readonly requireWriteAccessForAutomationTriggers: boolean;
}
