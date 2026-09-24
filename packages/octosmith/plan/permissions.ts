import type { Operation, Plan } from "./types.ts";

/** Identifies the access level required for a GitHub permission. */
export type GitHubPermissionAccess = "read" | "write";

/** Identifies a repository-level GitHub permission by its API name. */
export type RepositoryGitHubPermission =
  | "actions"
  | "administration"
  | "contents"
  | "repository_custom_properties"
  | "dependabot_secrets"
  | "environments"
  | "issues"
  | "metadata"
  | "pull_requests"
  | "secrets"
  | "actions_variables";

/** Identifies an organization-level GitHub permission by its API name. */
export type OrganizationGitHubPermission = "members";

/** Identifies a GitHub permission by its API name. */
export type GitHubPermission =
  | RepositoryGitHubPermission
  | OrganizationGitHubPermission;

/** Identifies the scope at which a GitHub permission applies. */
export type GitHubPermissionScope = GitHubPermissionRequirement["scope"];

/** Describes display metadata for a GitHub permission. */
export interface GitHubPermissionDescriptor<
  TPermission extends GitHubPermission = GitHubPermission,
> {
  readonly apiName: TPermission;
  readonly displayName: string;
}

/** Describes a normalized GitHub permission requirement. */
export type GitHubPermissionRequirement =
  | {
    readonly scope: "repository";
    readonly permission: RepositoryGitHubPermission;
    readonly access: GitHubPermissionAccess;
  }
  | {
    readonly scope: "organization";
    readonly permission: OrganizationGitHubPermission;
    readonly access: GitHubPermissionAccess;
  };

/** Identifies a planner operation type. */
export type OperationType = Operation["type"];

const repositoryPermissionDescriptors = {
  actions: { apiName: "actions", displayName: "Actions" },
  administration: { apiName: "administration", displayName: "Administration" },
  contents: { apiName: "contents", displayName: "Contents" },
  repository_custom_properties: {
    apiName: "repository_custom_properties",
    displayName: "Custom properties",
  },
  dependabot_secrets: {
    apiName: "dependabot_secrets",
    displayName: "Dependabot secrets",
  },
  environments: { apiName: "environments", displayName: "Environments" },
  issues: { apiName: "issues", displayName: "Issues" },
  metadata: { apiName: "metadata", displayName: "Metadata" },
  pull_requests: {
    apiName: "pull_requests",
    displayName: "Pull requests",
  },
  secrets: { apiName: "secrets", displayName: "Secrets" },
  actions_variables: { apiName: "actions_variables", displayName: "Variables" },
} as const satisfies Record<
  RepositoryGitHubPermission,
  GitHubPermissionDescriptor<RepositoryGitHubPermission>
>;

const organizationPermissionDescriptors = {
  members: { apiName: "members", displayName: "Members" },
} as const satisfies Record<
  OrganizationGitHubPermission,
  GitHubPermissionDescriptor<OrganizationGitHubPermission>
>;

const repository = (
  permission: RepositoryGitHubPermission,
  access: GitHubPermissionAccess,
): GitHubPermissionRequirement => ({
  scope: "repository",
  permission,
  access,
});

const organization = (
  permission: OrganizationGitHubPermission,
  access: GitHubPermissionAccess,
): GitHubPermissionRequirement => ({
  scope: "organization",
  permission,
  access,
});

const operationPermissions = {
  "update-repository-settings": [
    repository("administration", "write"),
  ],
  "set-custom-property": [
    repository("repository_custom_properties", "write"),
  ],
  "update-actions-settings": [
    repository("administration", "write"),
  ],
  "update-actions-oidc": [
    repository("actions", "write"),
  ],
  "set-team-permission": [
    repository("administration", "write"),
    organization("members", "read"),
    repository("metadata", "read"),
  ],
  "remove-team-permission": [
    repository("administration", "write"),
    organization("members", "read"),
    repository("metadata", "read"),
  ],
  "set-actions-variable": [
    repository("actions_variables", "write"),
  ],
  "remove-actions-variable": [
    repository("actions_variables", "write"),
  ],
  "set-actions-secret": [
    repository("secrets", "write"),
  ],
  "remove-actions-secret": [
    repository("secrets", "write"),
  ],
  "set-dependabot-secret": [
    repository("dependabot_secrets", "write"),
  ],
  "remove-dependabot-secret": [
    repository("dependabot_secrets", "write"),
  ],
  "create-ruleset": [
    repository("administration", "write"),
  ],
  "update-ruleset": [
    repository("administration", "write"),
  ],
  "delete-ruleset": [
    repository("administration", "write"),
  ],
  "create-environment": [
    repository("administration", "write"),
    repository("environments", "write"),
  ],
  "update-environment": [
    repository("environments", "write"),
  ],
  "delete-environment": [
    repository("administration", "write"),
  ],
  "create-file": [
    repository("contents", "write"),
    repository("issues", "write"),
    repository("pull_requests", "write"),
  ],
  "update-file": [
    repository("contents", "write"),
    repository("issues", "write"),
    repository("pull_requests", "write"),
  ],
  "delete-file": [
    repository("contents", "write"),
    repository("issues", "write"),
    repository("pull_requests", "write"),
  ],
} as const satisfies Record<
  OperationType,
  readonly GitHubPermissionRequirement[]
>;

/** Returns display metadata for a normalized GitHub permission requirement. */
export function getGitHubPermissionDescriptor(
  requirement: GitHubPermissionRequirement,
): GitHubPermissionDescriptor;

/** Returns display metadata for a repository-level GitHub permission. */
export function getGitHubPermissionDescriptor(
  scope: "repository",
  permission: RepositoryGitHubPermission,
): GitHubPermissionDescriptor<RepositoryGitHubPermission>;

/** Returns display metadata for an organization-level GitHub permission. */
export function getGitHubPermissionDescriptor(
  scope: "organization",
  permission: OrganizationGitHubPermission,
): GitHubPermissionDescriptor<OrganizationGitHubPermission>;

/** Returns display metadata for a GitHub permission. */
export function getGitHubPermissionDescriptor(
  scopeOrRequirement: GitHubPermissionScope | GitHubPermissionRequirement,
  permission?: GitHubPermission,
): GitHubPermissionDescriptor {
  const scope = typeof scopeOrRequirement === "string"
    ? scopeOrRequirement
    : scopeOrRequirement.scope;
  const apiName = typeof scopeOrRequirement === "string"
    ? permission
    : scopeOrRequirement.permission;

  if (scope === "repository") {
    return repositoryPermissionDescriptors[
      apiName as RepositoryGitHubPermission
    ];
  }

  return organizationPermissionDescriptors[
    apiName as OrganizationGitHubPermission
  ];
}

/** Returns the GitHub permissions required by an operation type. */
export function requiredPermissionsForOperationType(
  type: OperationType,
): readonly GitHubPermissionRequirement[] {
  return operationPermissions[type];
}

/** Returns the GitHub permissions required by an operation. */
export function requiredPermissionsForOperation(
  operation: Operation,
): readonly GitHubPermissionRequirement[] {
  return requiredPermissionsForOperationType(operation.type);
}

/**
 * Aggregates permission requirements, retaining the strongest access level for
 * duplicate scope/permission pairs and returning a deterministic order.
 */
export function aggregateGitHubPermissionRequirements(
  requirements: readonly GitHubPermissionRequirement[],
): readonly GitHubPermissionRequirement[] {
  const aggregated = new Map<string, GitHubPermissionRequirement>();

  for (const requirement of requirements) {
    const key = requirement.scope + ":" + requirement.permission;
    const current = aggregated.get(key);

    if (
      current === undefined ||
      (current.access === "read" && requirement.access === "write")
    ) {
      aggregated.set(key, requirement);
    }
  }

  return [...aggregated.values()].sort((left, right) =>
    compareStrings(left.scope, right.scope) ||
    compareStrings(left.permission, right.permission)
  );
}

/** Returns the aggregated GitHub permissions required by a plan. */
export function requiredPermissionsForPlan(
  plan: Plan,
): readonly GitHubPermissionRequirement[] {
  return aggregateGitHubPermissionRequirements(
    plan.operations.flatMap(requiredPermissionsForOperation),
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
