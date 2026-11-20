import type { RepositoryVisibility } from "../types.ts";
import type { GitHubClient } from "./client.ts";

/** Validated identity supplied to GitHub without optional repository defaults. */
export interface OrganizationRepositoryCreationRequest {
  readonly name: string;
  readonly visibility: RepositoryVisibility;
}

/** GitHub's identity for a newly created repository. */
export interface CreatedRepository {
  readonly name: string;
  readonly fullName: string;
  readonly url: string;
  readonly owner?: string;
}

/** Create an empty repository for an organization or the authenticated user. */
export async function createRepositoryForOwner(
  client: GitHubClient,
  owner: string,
  type: "Organization" | "User",
  request: OrganizationRepositoryCreationRequest,
): Promise<CreatedRepository> {
  const response = await client.request<{
    readonly name: string;
    readonly full_name: string;
    readonly html_url: string;
    readonly owner?: { readonly login?: string };
  }>(
    "POST",
    type === "Organization"
      ? "/orgs/" + encodeURIComponent(owner) + "/repos"
      : "/user/repos",
    {
      body: {
        name: request.name,
        ...(type === "User"
          ? { private: request.visibility === "private" }
          : { visibility: request.visibility }),
        auto_init: false,
      },
    },
  );
  if (
    response.name !== request.name ||
    response.full_name.toLowerCase() !==
      `${owner}/${request.name}`.toLowerCase() ||
    (type === "User" &&
      response.owner?.login?.toLowerCase() !== owner.toLowerCase())
  ) {
    throw new Error(
      "GitHub returned an unexpected repository identity after creation; no bootstrap or reconciliation was attempted.",
    );
  }
  return {
    name: response.name,
    fullName: response.full_name,
    url: response.html_url,
    ...(type === "User" && { owner: response.owner!.login! }),
  };
}

/** Backwards-compatible organization creation entry point. */
export async function createOrganizationRepository(
  client: GitHubClient,
  organization: string,
  request: OrganizationRepositoryCreationRequest,
): Promise<CreatedRepository> {
  return await createRepositoryForOwner(
    client,
    organization,
    "Organization",
    request,
  );
}
