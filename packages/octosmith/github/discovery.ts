import type {
  LoadedConfiguration,
  PropertyValue,
  RepositoryMetadata,
  RepositorySelector,
  RepositoryVisibility,
} from "../mod.ts";
import { matchesScope } from "../mod.ts";
import type { GitHubClient, GitHubQueryValue } from "./client.ts";
import {
  assertRepositoryOwnerCapabilities,
  type ResolvedRepositoryOwner,
  resolveRepositoryOwner,
} from "./owner.ts";

interface RepositoryResponse {
  readonly name: string;
  readonly visibility: RepositoryVisibility;
  readonly owner?: { readonly login: string };
}

interface RepositoryPropertiesResponse {
  readonly repository_name: string;
  readonly properties: readonly {
    readonly property_name: string;
    readonly value: PropertyValue;
  }[];
}

/** Describes repository discovery failure. */
export interface RepositoryDiscoveryFailure {
  readonly repository: string;
  readonly error: unknown;
}

/** Describes repository discovery result. */
export interface RepositoryDiscoveryResult {
  readonly repositories: readonly RepositoryMetadata[];
  readonly failures: readonly RepositoryDiscoveryFailure[];
  readonly owner?: ResolvedRepositoryOwner;
}

interface CandidateDiscoveryResult {
  readonly repositories: readonly RepositoryResponse[];
  readonly failures: readonly RepositoryDiscoveryFailure[];
}

const PAGE_SIZE = 100;

/** Discover repositories in configured scope, optionally targeting one repository. */
export async function discoverRepositories(
  client: GitHubClient,
  loaded: LoadedConfiguration,
  repository?: string,
  resolvedOwner?: ResolvedRepositoryOwner,
): Promise<RepositoryDiscoveryResult> {
  if (repository !== undefined && repository.length === 0) {
    throw new Error("Repository target must not be empty");
  }

  const configuredOwner = loaded.configuration.organization;
  if (repository !== undefined) {
    normalizeRepositoryTarget(repository, configuredOwner);
  }
  const owner = resolvedOwner ??
    await resolveRepositoryOwner(client, configuredOwner);
  if (owner.login.toLowerCase() !== configuredOwner.toLowerCase()) {
    throw new Error(
      `Resolved GitHub owner "${owner.login}" does not match configured owner "${configuredOwner}".`,
    );
  }
  assertRepositoryOwnerCapabilities(loaded, owner);
  const targetRepository = repository === undefined
    ? undefined
    : normalizeRepositoryTarget(repository, owner.login);
  const scopes = [
    loaded.configuration.repositories.scope,
    ...Object.values(loaded.templates).flatMap((template) =>
      template.match === undefined ? [] : [template.match]
    ),
  ];
  const selectors = scopes.flatMap((scope) => [
    ...(scope.include === "all" ? [] : [scope.include]),
    ...(scope.exclude === undefined ? [] : [scope.exclude]),
  ]);
  const referencedTeams = collectReferencedTeams(selectors);
  const referencedProperties = collectReferencedProperties(selectors);
  const teamRepositories = new Map<string, ReadonlySet<string>>();

  if (targetRepository) {
    return await discoverTargetRepository(
      client,
      loaded,
      targetRepository,
      referencedTeams,
      referencedProperties,
      owner,
    );
  }

  const discovery = await discoverCandidates(
    client,
    owner,
    loaded.configuration.repositories.scope.include === "all"
      ? {}
      : loaded.configuration.repositories.scope.include,
    teamRepositories,
  );

  for (const team of referencedTeams) {
    if (!teamRepositories.has(team)) {
      teamRepositories.set(
        team,
        new Set(
          (await listTeamRepositories(client, owner.login, team))
            .map((repository) => repository.name),
        ),
      );
    }
  }

  const properties = referencedProperties.size > 0
    ? await loadRepositoryProperties(client, owner.login, referencedProperties)
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
        matchesScope(loaded.configuration.repositories.scope, repository)
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
    failures: discovery.failures,
    ...(owner.type === "User" && { owner }),
  };
}

async function discoverTargetRepository(
  client: GitHubClient,
  loaded: LoadedConfiguration,
  repository: string,
  referencedTeams: ReadonlySet<string>,
  referencedProperties: ReadonlySet<string>,
  owner: ResolvedRepositoryOwner,
): Promise<RepositoryDiscoveryResult> {
  const path = "/repos/" + encodeURIComponent(owner.login) + "/" +
    encodeURIComponent(repository);

  try {
    const response = await client.get<RepositoryResponse>(path);
    if (!isOwnedBy(response, owner)) {
      return {
        repositories: [],
        failures: [{
          repository,
          error: new Error(
            `Repository ${owner.login}/${repository} is not owned by ${owner.login}.`,
          ),
        }],
        ...(owner.type === "User" && { owner }),
      };
    }
    const teams = referencedTeams.size > 0
      ? await getAllPages<{ readonly slug: string }>(client, path + "/teams")
      : [];
    // GitHub returns all repository property values in one unpaginated response.
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

    if (!matchesScope(loaded.configuration.repositories.scope, metadata)) {
      return {
        repositories: [],
        failures: [{
          repository,
          error: new Error(
            "Repository " + repository + " is outside the configured scope",
          ),
        }],
        ...(owner.type === "User" && { owner }),
      };
    }

    return {
      repositories: [metadata],
      failures: [],
      ...(owner.type === "User" && { owner }),
    };
  } catch (error) {
    return {
      repositories: [],
      failures: [{ repository, error }],
      ...(owner.type === "User" && { owner }),
    };
  }
}

async function discoverCandidates(
  client: GitHubClient,
  owner: ResolvedRepositoryOwner,
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
              "/repos/" + encodeURIComponent(owner.login) + "/" +
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
        "repository" in result && isOwnedBy(result.repository, owner)
          ? [result.repository]
          : []
      ),
      failures: results.flatMap((result) =>
        "error" in result
          ? [{ repository: result.name, error: result.error }]
          : !isOwnedBy(result.repository, owner)
          ? [{
            repository: result.repository.name,
            error: new Error(
              `Repository ${owner.login}/${result.repository.name} is not owned by ${owner.login}.`,
            ),
          }]
          : []
      ),
    };
  }

  if (scope.teams?.length) {
    const team = scope.teams[0];
    const repositories = await listTeamRepositories(
      client,
      owner.login,
      team,
    );
    teamRepositories.set(
      team,
      new Set(repositories.map((repository) => repository.name)),
    );
    return { repositories, failures: [] };
  }

  const visibility = singleVisibility(scope.visibility);
  const repositories = await getAllPages<RepositoryResponse>(
    client,
    owner.type === "Organization"
      ? "/orgs/" + encodeURIComponent(owner.login) + "/repos"
      : "/user/repos",
    owner.type === "Organization"
      ? { ...(visibility && { type: visibility }) }
      : { type: "owner" },
  );
  return {
    repositories: repositories.filter((repository) =>
      isOwnedBy(repository, owner) &&
      (owner.type === "Organization" || !visibility ||
        repository.visibility === visibility)
    ),
    failures: [],
  };
}

function isOwnedBy(
  repository: RepositoryResponse,
  owner: ResolvedRepositoryOwner,
): boolean {
  return owner.type !== "User" ||
    repository.owner?.login.toLowerCase() === owner.login.toLowerCase();
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

function normalizeRepositoryTarget(
  target: string,
  ownerLogin: string,
): string {
  const parts = target.split("/");

  if (parts.length === 1) {
    return target;
  }

  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(
      'Repository target must be a repository name or "owner/repository"',
    );
  }

  const [, repository] = parts;
  if (parts[0].toLowerCase() !== ownerLogin.toLowerCase()) {
    throw new Error(
      `Repository target owner "${
        parts[0]
      }" does not match configured owner "${ownerLogin}"`,
    );
  }

  return repository;
}

function isExactRepositoryName(pattern: string): boolean {
  return !pattern.includes("*") && !pattern.includes("?");
}
