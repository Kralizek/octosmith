import { type GitHubClient, GitHubRequestError } from "./client.ts";
import type { NormalizedConfiguration } from "../configuration/types.ts";

/** Canonical GitHub identity, independent of workflow capabilities. */
export interface GitHubOwner {
  readonly login: string;
  readonly type: "Organization" | "User";
}

/** Owner configuration as declared by the user. */
export interface GitHubOwnerDeclaration {
  readonly login: string;
  readonly type: GitHubOwner["type"];
}

/** Get the explicit configured account identity from normalized configuration. */
export function getGitHubOwnerDeclaration(
  configuration: NormalizedConfiguration,
): GitHubOwnerDeclaration {
  if (configuration.owner !== undefined) {
    if (
      configuration.owner.toLowerCase() !==
        configuration.organization.toLowerCase()
    ) {
      throw new GitHubOwnerError(
        "Normalized personal owner identity does not match the declared owner; no changes were applied.",
      );
    }
    return { login: configuration.owner, type: "User" };
  }
  return { login: configuration.organization, type: "Organization" };
}

/** Capabilities that are structurally available for an owner kind. */
export interface GitHubOwnerCapabilities {
  readonly teams: boolean;
  readonly customProperties: boolean;
  readonly internalVisibility: boolean;
  readonly organizationOidc: boolean;
}

/** Canonical owner and structural capabilities resolved for one operation. */
export interface GitHubOwnerContext extends GitHubOwner {
  readonly capabilities: GitHubOwnerCapabilities;
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
      `GitHub owner "${response.login}" has an unexpected account type. Use organization: for a GitHub organization or owner: for a personal account. No changes were applied.`,
    );
  }

  return { login: response.login, type: response.type };
}

/** Resolve and validate declared type and authenticated-user identity. */
export async function resolveGitHubOwnerContext(
  client: GitHubClient,
  declaration: GitHubOwnerDeclaration,
): Promise<GitHubOwnerContext> {
  const owner = await resolveGitHubOwner(client, declaration.login);
  if (owner.type !== declaration.type) {
    if (declaration.type === "Organization" && owner.type === "User") {
      throw new GitHubOwnerError(
        `GitHub owner "${owner.login}" is a personal account (User), but organization: requires an Organization; no changes were applied.`,
      );
    }
    throw new GitHubOwnerError(
      `Configured ${
        declaration.type === "Organization" ? "organization" : "owner"
      } "${declaration.login}" resolves to a GitHub ${owner.type}. The declared account type must match; no changes were applied.`,
    );
  }
  if (owner.type === "User") {
    let authenticated: unknown;
    try {
      authenticated = await client.get<unknown>("/user");
    } catch (error) {
      const status = error instanceof GitHubRequestError
        ? error.status
        : undefined;
      throw new GitHubOwnerError(
        `Cannot verify the authenticated personal account` +
          (status === undefined ? "" : ` (HTTP ${status})`) +
          ". Use a token that identifies the configured user and has access to personal repositories; no changes were applied.",
        status,
      );
    }
    if (
      typeof authenticated !== "object" || authenticated === null ||
      !("login" in authenticated) || typeof authenticated.login !== "string" ||
      authenticated.login.toLowerCase() !== owner.login.toLowerCase()
    ) {
      throw new GitHubOwnerError(
        `Authenticated GitHub user does not match configured personal owner "${owner.login}". Personal repositories can only be provisioned for the authenticated user; no changes were applied.`,
      );
    }
  }
  return {
    ...owner,
    capabilities: owner.type === "Organization"
      ? {
        teams: true,
        customProperties: true,
        internalVisibility: true,
        organizationOidc: true,
      }
      : {
        teams: false,
        customProperties: false,
        internalVisibility: false,
        organizationOidc: false,
      },
  };
}

/** Enforce current organization-only capabilities without changing identity resolution. */
export function assertOrganizationOwner(owner: GitHubOwner): void {
  if (owner.type !== "Organization") {
    throw new GitHubOwnerError(
      `GitHub owner "${owner.login}" is a personal account (User). Octosmith currently supports organizations only; set organization: to a GitHub organization login. Personal-account support is tracked in #125; no changes were applied.`,
    );
  }
}
