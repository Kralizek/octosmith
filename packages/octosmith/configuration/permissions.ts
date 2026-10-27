import {
  aggregateGitHubPermissionRequirements,
  type GitHubPermissionRequirement,
  type OperationType,
  requiredPermissionsForFileReconciliation,
  requiredPermissionsForManagedFile,
  requiredPermissionsForOperationType,
} from "../plan/permissions.ts";
import type { LoadedConfiguration } from "./load.ts";
import {
  normalizeRepositorySettings,
  resolveTemplateIdentity,
} from "./resolve.ts";
import {
  effectiveRepositorySelectorIntersection,
  templateCanMatchScope,
} from "./validate.ts";
import type { RepositoryConfiguration } from "./types.ts";

/** Creation authorization is distinct from ongoing repository reconciliation. */
export interface RepositoryCreationPermissionAnalysis {
  readonly organization: string;
  readonly creation: readonly GitHubPermissionRequirement[];
  readonly selectorMetadata: readonly GitHubPermissionRequirement[];
  readonly reconciliation: readonly GitHubPermissionRequirement[];
  readonly constraints: readonly string[];
}

/** Analyze creation-only authorization without changing plan/apply requirements. */
export function requiredPermissionsForRepositoryCreation(
  loaded: LoadedConfiguration,
  templateName: string,
): RepositoryCreationPermissionAnalysis {
  const identity = resolveTemplateIdentity(loaded, templateName);
  const template = loaded.templates[identity];
  const intersection = effectiveRepositorySelectorIntersection(
    loaded.configuration.repositories.scope,
    template,
    identity,
  );
  const metadata: GitHubPermissionRequirement[] = [
    { scope: "repository", permission: "metadata", access: "read" },
  ];
  if (
    intersection.effective?.requiredTeams.length ||
    template.repository.teams?.length
  ) {
    metadata.push(
      ...requiredPermissionsForOperationType("set-team-permission"),
    );
  }
  if (
    Object.keys(intersection.effective?.requiredProperties ?? {}).length ||
    Object.keys(template.repository.customProperties ?? {}).length
  ) {
    metadata.push(
      ...requiredPermissionsForOperationType("set-custom-property"),
    );
  }
  return {
    organization: loaded.configuration.organization,
    creation: [{
      scope: "repository",
      permission: "administration",
      access: "write",
    }],
    selectorMetadata: aggregateGitHubPermissionRequirements(metadata),
    reconciliation: aggregateGitHubPermissionRequirements([
      { scope: "repository", permission: "contents", access: "read" },
      ...potentialOperationTypes(
        template.repository,
        loaded.configuration.repositories.settings?.collectionManagement ===
          "strict",
      ).filter((type) => type !== "initialize-repository").flatMap((type) =>
        requiredPermissionsForOperationType(type)
      ),
    ]),
    constraints: [
      "Organization repository creation requires Administration: write on a supported fine-grained token/GitHub App, or the appropriate classic PAT repo/public_repo scope, and an actor allowed to create the requested visibility in this organization.",
      "Organization/enterprise policy, SSO authorization, internal-visibility availability and GitHub App repository installation access can prevent creation or access to the new repository.",
      "Selector team assignments require repository Administration: write and organization Members: read. Custom property definitions and editing policy must allow repository value assignment.",
      "Contents: read is used to detect empty history; no Contents: write, commits, branches or file pull requests are used during API-side creation.",
    ],
  };
}

/** Analyze the worst-case permissions of the reachable, composed templates. */
export function requiredPermissionsForConfiguration(
  loaded: LoadedConfiguration,
  templateName?: string,
): readonly GitHubPermissionRequirement[] {
  let selected = Object.entries(loaded.templates);
  if (templateName !== undefined) {
    const identity = templateName.startsWith("repository:")
      ? templateName
      : "repository:" + templateName;
    const template = loaded.templates[identity];
    if (template === undefined) {
      throw new Error("Unknown template: " + templateName);
    }
    selected = [[identity, template]];
  }

  const fallbackIdentity =
    loaded.configuration.repositories.settings?.unmatchedRepositories ===
        "fallback"
      ? loaded.configuration.repositories.settings.fallbackTemplate
      : undefined;
  const strict = loaded.configuration.repositories.settings
    ?.collectionManagement === "strict";
  const delivery = loaded.configuration.repositories.fileChanges?.mode ??
    "pull_request";
  const requirements = selected.flatMap(([identity, template]) => {
    if (
      !templateCanMatchScope(
        loaded.configuration.repositories.scope,
        template,
        identity === fallbackIdentity,
      )
    ) {
      return [];
    }

    return [
      ...(delivery === "pull_request"
        ? requiredPermissionsForFileReconciliation()
        : []),
      ...potentialOperationTypes(template.repository, strict).flatMap((type) =>
        requiredPermissionsForOperationType(type, delivery)
      ),
      ...Object.keys(template.repository.files ?? {}).flatMap((path) =>
        requiredPermissionsForManagedFile(path, delivery)
      ),
    ];
  });

  return aggregateGitHubPermissionRequirements(requirements);
}

function potentialOperationTypes(
  repository: RepositoryConfiguration,
  strict: boolean,
): OperationType[] {
  const types: OperationType[] = ["initialize-repository"];

  if (
    repository.settings &&
    hasConfiguredValue(normalizeRepositorySettings(repository.settings))
  ) {
    types.push("update-repository-settings");
  }
  if (
    repository.customProperties !== undefined &&
    (strict || Object.keys(repository.customProperties).length > 0)
  ) {
    types.push("set-custom-property");
  }

  const actions = repository.actions;
  if (actions) {
    if (
      actions.enabled !== undefined ||
      actions.allowedActions !== undefined ||
      actions.shaPinningRequired !== undefined ||
      (actions.selectedActions !== undefined &&
        Object.keys(actions.selectedActions).length > 0)
    ) {
      types.push("update-actions-settings");
    }
    if (actions.oidc && Object.keys(actions.oidc).length > 0) {
      types.push("update-actions-oidc");
    }
    if (actions.secrets !== undefined) {
      if (actions.secrets.length > 0) types.push("set-actions-secret");
      if (strict) types.push("remove-actions-secret");
    }
    if (actions.variables !== undefined) {
      if (actions.variables.length > 0) types.push("set-actions-variable");
      if (strict) types.push("remove-actions-variable");
    }
  }
  if (repository.dependabot?.secrets !== undefined) {
    if (repository.dependabot.secrets.length > 0) {
      types.push("set-dependabot-secret");
    }
    if (strict) types.push("remove-dependabot-secret");
  }
  if (repository.teams !== undefined) {
    if (repository.teams.length > 0) types.push("set-team-permission");
    if (strict) types.push("remove-team-permission");
  }
  if (repository.rulesets !== undefined) {
    if (repository.rulesets.length > 0) {
      types.push("create-ruleset", "update-ruleset");
    }
    if (strict) types.push("delete-ruleset");
  }
  if (repository.environments !== undefined) {
    if (repository.environments.length > 0) {
      types.push("create-environment", "update-environment");
    }
    if (strict) types.push("delete-environment");
  }
  return types;
}

function hasConfiguredValue(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return true;
  }

  return Object.values(value as Record<string, unknown>).some(
    hasConfiguredValue,
  );
}
