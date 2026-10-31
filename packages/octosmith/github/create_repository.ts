import type { RepositoryVisibility } from "../types.ts";
import type { GitHubClient } from "./client.ts";
import type { ResolvedRepositoryOwner } from "./owner.ts";

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
}

/** Create an empty organization repository, leaving all content to bootstrap. */
export async function createOrganizationRepository(
  client: GitHubClient,
  organization: string,
  request: OrganizationRepositoryCreationRequest,
): Promise<CreatedRepository> {
  return await createRepositoryForOwner(
    client,
    { login: organization, type: "Organization" },
    request,
  );
}

/** Create an empty repository using the endpoint for the resolved owner type. */
export async function createRepositoryForOwner(
  client: GitHubClient,
  owner: ResolvedRepositoryOwner,
  request: OrganizationRepositoryCreationRequest,
): Promise<CreatedRepository> {
  const response = await client.request<{
    readonly name: string;
    readonly full_name: string;
    readonly html_url: string;
  }>(
    "POST",
    owner.type === "Organization"
      ? "/orgs/" + encodeURIComponent(owner.login) +
        "/repos"
      : "/user/repos",
    {
      body: {
        name: request.name,
        visibility: request.visibility,
        auto_init: false,
      },
    },
  );
  return {
    name: response.name,
    fullName: response.full_name,
    url: response.html_url,
  };
}
