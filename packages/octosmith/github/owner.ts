import type { LoadedConfiguration } from "../configuration/load.ts";
import { type GitHubClient, GitHubRequestError } from "./client.ts";

/** GitHub owner types supported by repository workflows. */
export type RepositoryOwnerType = "User" | "Organization";

/** Canonical owner identity resolved from GitHub for one operation. */
export interface ResolvedRepositoryOwner {
  readonly login: string;
  readonly type: RepositoryOwnerType;
}

interface GitHubUserResponse {
  readonly login?: string;
  readonly type?: string;
}

/** Resolve a configured owner and verify personal owners against the token. */
export async function resolveRepositoryOwner(
  client: GitHubClient,
  configuredOwner: string,
): Promise<ResolvedRepositoryOwner> {
  let response: GitHubUserResponse;
  try {
    response = await client.get<GitHubUserResponse>(
      "/users/" + encodeURIComponent(configuredOwner),
    );
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404) {
      throw new RepositoryOwnerResolutionError(
        `Configured GitHub owner "${configuredOwner}" could not be resolved. Verify that it exists and is visible to the authenticated token.`,
      );
    }
    throw error;
  }

  if (
    typeof response.login !== "string" || response.login.length === 0
  ) {
    throw new RepositoryOwnerResolutionError(
      `GitHub returned an invalid identity for configured owner "${configuredOwner}".`,
    );
  }
  if (response.type !== "User" && response.type !== "Organization") {
    throw new RepositoryOwnerResolutionError(
      `GitHub owner "${configuredOwner}" has unsupported type "${
        response.type ?? "unknown"
      }"; expected a user or organization.`,
    );
  }

  const owner: ResolvedRepositoryOwner = {
    login: response.login,
    type: response.type,
  };
  if (owner.type === "User") {
    const authenticated = await client.get<GitHubUserResponse>("/user");
    if (
      typeof authenticated.login !== "string" ||
      authenticated.login.toLowerCase() !== owner.login.toLowerCase()
    ) {
      throw new RepositoryOwnerResolutionError(
        `Personal repository owner "${owner.login}" is not the authenticated GitHub user; personal-account operations are limited to the authenticated account.`,
      );
    }
  }
  return owner;
}

/** Fail before discovery or mutation when a personal owner has org-only intent. */
export function assertRepositoryOwnerCapabilities(
  loaded: LoadedConfiguration,
  owner: ResolvedRepositoryOwner,
): void {
  if (owner.type !== "User") return;

  const unsupported: string[] = [];
  const addSelectorCapabilities = (
    scopePath: string,
    scope: LoadedConfiguration["configuration"]["repositories"]["scope"],
  ) => {
    for (
      const [side, selector] of [
        ["include", scope.include],
        ["exclude", scope.exclude],
      ] as const
    ) {
      if (!selector || selector === "all") continue;
      if (selector.teams?.length) {
        unsupported.push(`${scopePath}.${side}.teams`);
      }
      if (Object.keys(selector.properties ?? {}).length) {
        unsupported.push(`${scopePath}.${side}.properties`);
      }
    }
  };

  addSelectorCapabilities(
    "repositories.scope",
    loaded.configuration.repositories.scope,
  );
  for (const [identity, template] of Object.entries(loaded.templates)) {
    if (template.match) {
      addSelectorCapabilities(`templates.${identity}.match`, template.match);
    }
    if (template.repository.teams?.length) {
      unsupported.push(`templates.${identity}.repository.teams`);
    }
    if (Object.keys(template.repository.customProperties ?? {}).length) {
      unsupported.push(
        `templates.${identity}.repository.customProperties`,
      );
    }
  }

  if (unsupported.length > 0) {
    throw new RepositoryOwnerResolutionError(
      `Personal GitHub account "${owner.login}" does not support organization-only repository declarations: ${
        [...new Set(unsupported)].join(", ")
      }. Remove these declarations or configure an organization owner.`,
    );
  }
}

/** An actionable failure while resolving or validating repository ownership. */
export class RepositoryOwnerResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryOwnerResolutionError";
  }
}
