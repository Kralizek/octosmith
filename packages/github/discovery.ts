import type {
  LoadedConfiguration,
  PropertyValue,
  RepositoryMetadata,
  RepositorySelector,
  RepositoryVisibility,
} from "@octosmith/core";
import { matchesSelector } from "@octosmith/core";
import type { GitHubClient, GitHubQueryValue } from "./client.ts";

interface RepositoryResponse {
  readonly name: string;
  readonly visibility: RepositoryVisibility;
}

interface RepositoryPropertiesResponse {
  readonly repository_name: string;
  readonly properties: readonly {
    readonly property_name: string;
    readonly value: PropertyValue;
  }[];
}

export interface RepositoryDiscoveryFailure {
  readonly repository: string;
  readonly error: unknown;
}

export interface RepositoryDiscoveryResult {
  readonly repositories: readonly RepositoryMetadata[];
  readonly failures: readonly RepositoryDiscoveryFailure[];
}

interface CandidateDiscoveryResult {
  readonly repositories: readonly RepositoryResponse[];
  readonly failures: readonly RepositoryDiscoveryFailure[];
}

const PAGE_SIZE = 100;

export async function discoverRepositories(
  client: GitHubClient,
  loaded: LoadedConfiguration,
  repository?: string,
): Promise<RepositoryDiscoveryResult> {
  if (repository !== undefined && repository.length === 0) {
    throw new Error("Repository target must not be empty");
  }

  const organization = loaded.configuration.organization;
  const selectors = [
    loaded.configuration.scope,
    ...Object.values(loaded.templates).map((template) => template.match),
  ];
  const referencedTeams = collectReferencedTeams(selectors);
  const referencedProperties = collectReferencedProperties(selectors);
  const teamRepositories = new Map<string, ReadonlySet<string>>();

  if (repository) {
    return await discoverTargetRepository(
      client,
      loaded,
      repository,
      referencedTeams,
      referencedProperties,
    );
  }

  const discovery = await discoverCandidates(
    client,
    organization,
    loaded.configuration.scope,
    teamRepositories,
  );

  for (const team of referencedTeams) {
    if (!teamRepositories.has(team)) {
      teamRepositories.set(
        team,
        new Set(
          (await listTeamRepositories(client, organization, team))
            .map((repository) => repository.name),
        ),
      );
    }
  }

  const properties = referencedProperties.size > 0
    ? await loadRepositoryProperties(client, organization, referencedProperties)
    : new Map<string, Readonly<Record<string, PropertyValue>>>();

  const repositories = discovery.repositories.map((
    repository,
  ): RepositoryMetadata => ({
    name: repository.name,
    visibility: repository.visibility,
    teams: [...referencedTeams].filter((team) =>
      teamRepositories.get(team)?.has(repository.name)
    ),
    properties: properties.get(repository.name) ?? {},
  }));

  return {
    repositories: repositories
      .filter((repository) =>
        matchesSelector(loaded.configuration.scope, repository)
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
    failures: discovery.failures,
  };
}

async function discoverTargetRepository(
  client: GitHubClient,
  loaded: LoadedConfiguration,
  repository: string,
  referencedTeams: ReadonlySet<string>,
  referencedProperties: ReadonlySet<string>,
): Promise<RepositoryDiscoveryResult> {
  const organization = loaded.configuration.organization;
  const path = "/repos/" + encodeURIComponent(organization) + "/" +
    encodeURIComponent(repository);

  try {
    const response = await client.get<RepositoryResponse>(path);
    const teams = referencedTeams.size > 0
      ? await getAllPages<{ readonly slug: string }>(client, path + "/teams")
      : [];
    const propertyValues = referencedProperties.size > 0
      ? await client.get<
        readonly {
          readonly property_name: string;
          readonly value: PropertyValue;
        }[]
      >(path + "/properties/values")
      : [];

    const metadata: RepositoryMetadata = {
      name: response.name,
      visibility: response.visibility,
      teams: teams
        .map((team) => team.slug)
        .filter((team) => referencedTeams.has(team)),
      properties: Object.fromEntries(
        propertyValues
          .filter((property) =>
            referencedProperties.has(property.property_name)
          )
          .map((property) => [property.property_name, property.value]),
      ),
    };

    if (!matchesSelector(loaded.configuration.scope, metadata)) {
      return {
        repositories: [],
        failures: [{
          repository,
          error: new Error(
            "Repository " + repository + " is outside the configured scope",
          ),
        }],
      };
    }

    return { repositories: [metadata], failures: [] };
  } catch (error) {
    return {
      repositories: [],
      failures: [{ repository, error }],
    };
  }
}

async function discoverCandidates(
  client: GitHubClient,
  organization: string,
  scope: RepositorySelector,
  teamRepositories: Map<string, ReadonlySet<string>>,
): Promise<CandidateDiscoveryResult> {
  if (scope.names?.length && scope.names.every(isExactRepositoryName)) {
    const results: readonly (
      | { readonly repository: RepositoryResponse }
      | { readonly name: string; readonly error: unknown }
    )[] = await Promise.all(
      [...new Set(scope.names)].map(async (name) => {
        try {
          return {
            repository: await client.get<RepositoryResponse>(
              "/repos/" + encodeURIComponent(organization) + "/" +
                encodeURIComponent(name),
            ),
          };
        } catch (error) {
          return { name, error };
        }
      }),
    );

    return {
      repositories: results.flatMap((result) =>
        "repository" in result ? [result.repository] : []
      ),
      failures: results.flatMap((result) =>
        "error" in result
          ? [{ repository: result.name, error: result.error }]
          : []
      ),
    };
  }

  if (scope.teams?.length) {
    const team = scope.teams[0];
    const repositories = await listTeamRepositories(
      client,
      organization,
      team,
    );
    teamRepositories.set(
      team,
      new Set(repositories.map((repository) => repository.name)),
    );
    return { repositories, failures: [] };
  }

  const visibility = singleVisibility(scope.visibility);

  return {
    repositories: await getAllPages<RepositoryResponse>(
      client,
      "/orgs/" + encodeURIComponent(organization) + "/repos",
      {
        ...(visibility && { type: visibility }),
      },
    ),
    failures: [],
  };
}

async function listTeamRepositories(
  client: GitHubClient,
  organization: string,
  team: string,
): Promise<readonly RepositoryResponse[]> {
  return await getAllPages<RepositoryResponse>(
    client,
    "/orgs/" + encodeURIComponent(organization) + "/teams/" +
      encodeURIComponent(team) + "/repos",
  );
}

async function loadRepositoryProperties(
  client: GitHubClient,
  organization: string,
  referenced: ReadonlySet<string>,
): Promise<Map<string, Readonly<Record<string, PropertyValue>>>> {
  const responses = await getAllPages<RepositoryPropertiesResponse>(
    client,
    "/orgs/" + encodeURIComponent(organization) + "/properties/values",
  );
  const result = new Map<string, Readonly<Record<string, PropertyValue>>>();

  for (const repository of responses) {
    const properties = Object.fromEntries(
      repository.properties
        .filter((property) => referenced.has(property.property_name))
        .map((property) => [property.property_name, property.value]),
    ) as Readonly<Record<string, PropertyValue>>;

    result.set(repository.repository_name, properties);
  }

  return result;
}

async function getAllPages<T>(
  client: GitHubClient,
  path: string,
  query: Readonly<Record<string, GitHubQueryValue>> = {},
): Promise<readonly T[]> {
  const result: T[] = [];

  for (let page = 1;; page++) {
    const items = await client.get<readonly T[]>(path, {
      ...query,
      per_page: PAGE_SIZE,
      page,
    });
    result.push(...items);

    if (items.length < PAGE_SIZE) {
      return result;
    }
  }
}

function collectReferencedTeams(
  selectors: readonly RepositorySelector[],
): ReadonlySet<string> {
  return new Set(selectors.flatMap((selector) => selector.teams ?? []));
}

function collectReferencedProperties(
  selectors: readonly RepositorySelector[],
): ReadonlySet<string> {
  return new Set(
    selectors.flatMap((selector) => Object.keys(selector.properties ?? {})),
  );
}

function singleVisibility(
  visibility: RepositorySelector["visibility"],
): "public" | "private" | undefined {
  if (!visibility) {
    return undefined;
  }

  const value = Array.isArray(visibility)
    ? visibility.length === 1 ? visibility[0] : undefined
    : visibility;

  return value === "public" || value === "private" ? value : undefined;
}

function isExactRepositoryName(pattern: string): boolean {
  return !pattern.includes("*") && !pattern.includes("?");
}
