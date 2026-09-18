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

export interface CurrentActionsSettings {
  readonly enabled: boolean;
  readonly allowedActions: ActionsAllowedActions;
  readonly shaPinningRequired: boolean;
  readonly selectedActions?: CurrentSelectedActions;
}

export interface DesiredActionsSettings {
  readonly enabled?: boolean;
  readonly allowedActions?: ActionsAllowedActions;
  readonly shaPinningRequired?: boolean;
  readonly selectedActions?: DesiredSelectedActions;
}

export interface CopilotEnabledTools {
  readonly codeql: boolean;
  readonly copilotCodeReview: boolean;
  readonly secretScanning: boolean;
  readonly dependencyVulnerabilityChecks: boolean;
}

/**
 * Repository-level Copilot cloud-agent settings currently exposed by GitHub.
 *
 * GitHub's public REST API currently exposes these settings as read-only, so
 * OctoSmith does not model a desired counterpart yet.
 */
export interface CurrentCopilotSettings {
  readonly mcpConfiguration: unknown | null;
  readonly enabledTools: CopilotEnabledTools;
  readonly requireActionsWorkflowApproval: boolean;
  readonly firewallEnabled: boolean;
  readonly firewallRecommendedAllowlistEnabled: boolean;
  readonly customAllowlist: readonly string[];
  readonly automationsEnabled: boolean;
  readonly requireWriteAccessForAutomationTriggers: boolean;
}
