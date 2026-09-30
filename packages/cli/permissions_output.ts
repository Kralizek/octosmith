import type {
  GitHubPermissionRequirement,
  OrganizationGitHubPermission,
  RepositoryGitHubPermission,
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

const repositoryActionInputNames = {
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

const organizationActionInputNames = {
  members: "members",
} as const satisfies Record<OrganizationGitHubPermission, string>;

/**
 * Returns the `actions/create-github-app-token` `permission-*` input name
 * that corresponds to a normalized GitHub permission requirement.
 */
export function getPermissionActionInputName(
  requirement: GitHubPermissionRequirement,
): string {
  return requirement.scope === "repository"
    ? repositoryActionInputNames[requirement.permission]
    : organizationActionInputNames[requirement.permission];
}

/**
 * Renders permission requirements as deterministic `name=value` lines
 * compatible with the GitHub Actions `$GITHUB_OUTPUT` file format, using the
 * `permission-*` input names expected by `actions/create-github-app-token`.
 */
export function renderPermissionsGithubOutput(
  requirements: readonly GitHubPermissionRequirement[],
): string {
  return requirements
    .map((requirement) =>
      `permission-${
        getPermissionActionInputName(requirement)
      }=${requirement.access}`
    )
    .sort()
    .join("\n");
}
