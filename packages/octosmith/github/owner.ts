import { type GitHubClient, GitHubRequestError } from "./client.ts";

/** Canonical GitHub identity, independent of workflow capabilities. */
export interface GitHubOwner {
  readonly login: string;
  readonly type: "Organization" | "User";
}

/** Safe, actionable owner-resolution or capability failure. */
export class GitHubOwnerError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "GitHubOwnerError";
  }
}

/** Resolve identity through GitHub, never inferring account type from a 404. */
export async function resolveGitHubOwner(
  client: GitHubClient,
  configuredOwner: string,
): Promise<GitHubOwner> {
  let response: unknown;
  try {
    response = await client.get<unknown>(
      "/users/" + encodeURIComponent(configuredOwner),
    );
  } catch (error) {
    const status = error instanceof GitHubRequestError
      ? error.status
      : undefined;
    throw new GitHubOwnerError(
      `Cannot resolve configured GitHub owner "${configuredOwner}"` +
        (status === undefined ? "" : ` (HTTP ${status})`) +
        ". Check organization spelling, authentication, API connectivity and access; no changes were applied.",
      status,
    );
  }

  if (
    typeof response !== "object" || response === null ||
    !("login" in response) || typeof response.login !== "string" ||
    response.login.trim().length === 0
  ) {
    throw new GitHubOwnerError(
      `GitHub returned an invalid identity for configured owner "${configuredOwner}". Check the API endpoint and organization name; no changes were applied.`,
    );
  }
  if (
    !("type" in response) ||
    (response.type !== "Organization" && response.type !== "User")
  ) {
    throw new GitHubOwnerError(
      `GitHub owner "${response.login}" has an unexpected account type. Octosmith currently requires an Organization; set organization: to a GitHub organization login. No changes were applied.`,
    );
  }
  return { login: response.login, type: response.type };
}

/** Enforce current organization-only capabilities without changing identity resolution. */
export function assertOrganizationOwner(owner: GitHubOwner): void {
  if (owner.type !== "Organization") {
    throw new GitHubOwnerError(
      `GitHub owner "${owner.login}" is a personal account (User). Octosmith currently supports organizations only; set organization: to a GitHub organization login. Personal-account support is tracked in #125; no changes were applied.`,
    );
  }
}
