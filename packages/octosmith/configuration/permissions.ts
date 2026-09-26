import {
  aggregateGitHubPermissionRequirements,
  type GitHubPermissionRequirement,
  type OperationType,
  requiredPermissionsForOperationType,
} from "../plan/permissions.ts";
import type { LoadedConfiguration } from "./load.ts";
import { templateCanMatchScope } from "./validate.ts";
import type { RepositoryConfiguration } from "./types.ts";

/** Analyze the worst-case permissions of the reachable, composed templates. */
export function requiredPermissionsForConfiguration(
  loaded: LoadedConfiguration,
  templateName?: string,
): readonly GitHubPermissionRequirement[] {
  let selected = Object.values(loaded.templates);
  if (templateName !== undefined) {
    const template = loaded.templates[
      templateName.startsWith("repository:")
        ? templateName
        : "repository:" + templateName
    ];
    if (template === undefined) {
      throw new Error("Unknown template: " + templateName);
    }
    selected = [template];
  }

  const strict = loaded.configuration.repositories.settings
    ?.collectionManagement === "strict";
  const delivery = loaded.configuration.repositories.fileChanges?.mode ??
    "pull_request";
  const types = selected.flatMap((template) =>
    templateCanMatchScope(loaded.configuration.repositories.scope, template)
      ? potentialOperationTypes(template.repository, strict)
      : []
  );

  return aggregateGitHubPermissionRequirements(
    types.flatMap((type) =>
      requiredPermissionsForOperationType(type, delivery)
    ),
  );
}

function potentialOperationTypes(
  repository: RepositoryConfiguration,
  strict: boolean,
): OperationType[] {
  const types: OperationType[] = [];

  if (repository.settings && Object.keys(repository.settings).length > 0) {
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
  for (const file of Object.values(repository.files ?? {})) {
    if (file.ensure === "absent") {
      types.push("delete-file");
    } else {
      types.push("create-file");
      if (file.ensure === "exact") types.push("update-file");
    }
  }

  return types;
}
