export type CustomPropertyValue =
  | string
  | readonly string[]
  | null;

export type ActionsAllowedActions = "all" | "local-only" | "selected";

export interface CurrentSelectedActions {
  readonly githubOwnedAllowed: boolean;
  readonly verifiedAllowed: boolean;
  readonly patternsAllowed: readonly string[];
}

export interface DesiredSelectedActions {
  readonly githubOwnedAllowed?: boolean;
  readonly verifiedAllowed?: boolean;
  readonly patternsAllowed?: readonly string[];
}

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

export interface CurrentActionsOidcSettings {
  readonly subjectClaimTemplate: SubjectClaimTemplate;
  readonly immutableSubject: boolean;
}

export interface DesiredActionsOidcSettings {
  readonly subjectClaimTemplate?: SubjectClaimTemplate;
  readonly immutableSubject?: boolean;
}

export interface CurrentActionsSettings {
  readonly enabled: boolean;
  readonly allowedActions: ActionsAllowedActions;
  readonly shaPinningRequired: boolean;
  readonly selectedActions?: CurrentSelectedActions;
  readonly oidc: CurrentActionsOidcSettings;
}

export interface DesiredActionsSettings {
  readonly enabled?: boolean;
  readonly allowedActions?: ActionsAllowedActions;
  readonly shaPinningRequired?: boolean;
  readonly selectedActions?: DesiredSelectedActions;
  readonly oidc?: DesiredActionsOidcSettings;
}

export interface CopilotEnabledTools {
  readonly codeql: boolean;
  readonly copilotCodeReview: boolean;
  readonly secretScanning: boolean;
  readonly dependencyVulnerabilityChecks: boolean;
}

export interface CurrentCopilotMcpSettings {
  readonly configuration: unknown | null;
}

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
 * read-only, so OctoSmith does not model a desired counterpart yet.
 */
export interface CurrentCopilotSettings {
  readonly mcp: CurrentCopilotMcpSettings;
  readonly internetAccess: CurrentCopilotInternetAccessSettings;
  readonly enabledTools: CopilotEnabledTools;
  readonly requireActionsWorkflowApproval: boolean;
  readonly automationsEnabled: boolean;
  readonly requireWriteAccessForAutomationTriggers: boolean;
}
