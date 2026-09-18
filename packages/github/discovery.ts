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

const PAGE_SIZE = 100;

export async function discoverRepositories(
  client: GitHubClient,
  loaded: LoadedConfiguration,
): Promise<readonly RepositoryMetadata[]> {
  const organization = loaded.configuration.organization;
  const selectors = [
    loaded.configuration.scope,
    ...Object.values(loaded.templates).map((template) => template.match),
  ];
  const referencedTeams = collectReferencedTeams(selectors);
  const referencedProperties = collectReferencedProperties(selectors);
  const teamRepositories = new Map<string, ReadonlySet<string>>();

  const candidates = await discoverCandidates(
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

  const repositories = candidates.map((repository): RepositoryMetadata => ({
    name: repository.name,
    visibility: repository.visibility,
    teams: [...referencedTeams].filter((team) =>
      teamRepositories.get(team)?.has(repository.name)
    ),
    properties: properties.get(repository.name) ?? {},
  }));

  return repositories
    .filter((repository) =>
      matchesSelector(loaded.configuration.scope, repository)
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverCandidates(
  client: GitHubClient,
  organization: string,
  scope: RepositorySelector,
  teamRepositories: Map<string, ReadonlySet<string>>,
): Promise<readonly RepositoryResponse[]> {
  if (scope.names?.length && scope.names.every(isExactRepositoryName)) {
    return await Promise.all(
      [...new Set(scope.names)].map((name) =>
        client.get<RepositoryResponse>(
          "/repos/" + encodeURIComponent(organization) + "/" +
            encodeURIComponent(name),
        )
      ),
    );
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
    return repositories;
  }

  const visibility = singleVisibility(scope.visibility);

  return await getAllPages<RepositoryResponse>(
    client,
    "/orgs/" + encodeURIComponent(organization) + "/repos",
    {
      ...(visibility && { type: visibility }),
    },
  );
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
