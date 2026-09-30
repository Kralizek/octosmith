import {
  aggregateGitHubPermissionRequirements,
  type GitHubPermissionRequirement,
  type OrganizationGitHubPermission,
  type RepositoryGitHubPermission,
} from "@octosmith/octosmith";
import { type OutputFormat, parseOutputFormat } from "./output.ts";

/** Describes output formats supported by `template permissions`. */
export type PermissionOutputFormat = OutputFormat | "github-output";

/** Parse a CLI output format value for `template permissions`. */
export function parsePermissionOutputFormat(
  value: string,
): PermissionOutputFormat {
  if (value === "github-output") return value;

  try {
    return parseOutputFormat(value);
  } catch {
    throw new Error(
      "Unsupported output format: " + value +
        ". Expected text, json, or github-output",
    );
  }
}

// These maps are intentionally explicit (rather than derived by replacing
// `_` with `-`) so a mismatch with `actions/create-github-app-token`'s
// `permission-*` input names is caught by review rather than assumed. The
// `satisfies Record<...>` constraint below still guarantees a compile error
// if a new `RepositoryGitHubPermission`/`OrganizationGitHubPermission` value
// is added without a corresponding entry here.
const repositoryPermissionInputNames = {
  actions: "actions",
  administration: "administration",
  contents: "contents",
  repository_custom_properties: "repository-custom-properties",
  dependabot_secrets: "dependabot-secrets",
  environments: "environments",
  issues: "issues",
  metadata: "metadata",
  pull_requests: "pull-requests",
  secrets: "secrets",
  actions_variables: "actions-variables",
} as const satisfies Record<RepositoryGitHubPermission, string>;

const organizationPermissionInputNames = {
  members: "members",
} as const satisfies Record<OrganizationGitHubPermission, string>;

/**
 * Returns the `actions/create-github-app-token` `permission-*` input name
 * that corresponds to a normalized GitHub permission requirement.
 */
function getPermissionInputName(
  requirement: GitHubPermissionRequirement,
): string {
  switch (requirement.scope) {
    case "repository":
      return repositoryPermissionInputNames[requirement.permission];
    case "organization":
      return organizationPermissionInputNames[requirement.permission];
    default: {
      const unreachable: never = requirement;
      throw new Error(
        "Unsupported GitHub permission scope: " +
          JSON.stringify(unreachable),
      );
    }
  }
}

/**
 * Renders permission requirements as deterministic `name=value` lines
 * compatible with the GitHub Actions `$GITHUB_OUTPUT` file format, using the
 * `permission-*` input names expected by `actions/create-github-app-token`.
 * Duplicate scope/permission entries are aggregated first, retaining the
 * strongest access level, so each input name appears at most once.
 */
export function renderPermissionsGithubOutput(
  requirements: readonly GitHubPermissionRequirement[],
): string {
  return aggregateGitHubPermissionRequirements(requirements)
    .map((requirement) => ({
      name: getPermissionInputName(requirement),
      access: requirement.access,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, access }) => `permission-${name}=${access}`)
    .join("\n");
}
