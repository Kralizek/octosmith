import { assertEquals } from "@std/assert";
import type { LoadedConfiguration, RepositoryTemplate } from "@octosmith/core";
import {
  discoverRepositories,
  type GitHubClient,
  type GitHubQueryValue,
} from "@octosmith/github";

interface Request {
  readonly path: string;
  readonly query: Readonly<Record<string, GitHubQueryValue>>;
}

class FakeGitHubClient implements GitHubClient {
  readonly requests: Request[] = [];
  readonly #responses: Map<string, unknown[]>;

  constructor(responses: Readonly<Record<string, unknown[]>>) {
    this.#responses = new Map(Object.entries(responses));
  }

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    if (method !== "GET") {
      throw new Error("Unexpected method: " + method);
    }

    return this.get(path, options.query);
  }

  get<T>(
    path: string,
    query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    this.requests.push({ path, query });
    const key = requestKey(path, query);
    const responses = this.#responses.get(key);

    if (!responses?.length) {
      throw new Error("Unexpected request: " + key);
    }

    return Promise.resolve(responses.shift() as T);
  }
}

Deno.test("discovery fetches exact repository names directly", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
    "/repos/acme/web": [{ name: "web", visibility: "public" }],
  });

  const repositories = await discoverRepositories(
    client,
    configuration({
      scope: { names: ["api", "web"] },
    }),
  );

  assertEquals(repositories, [
    { name: "api", visibility: "private", teams: [], properties: {} },
    { name: "web", visibility: "public", teams: [], properties: {} },
  ]);
  assertEquals(client.requests.map((request) => request.path), [
    "/repos/acme/api",
    "/repos/acme/web",
  ]);
});

Deno.test("discovery deduplicates exact repository names", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
  });

  const repositories = await discoverRepositories(
    client,
    configuration({
      scope: { names: ["api", "api"] },
    }),
  );

  assertEquals(repositories, [
    { name: "api", visibility: "private", teams: [], properties: {} },
  ]);
  assertEquals(client.requests.map((request) => request.path), [
    "/repos/acme/api",
  ]);
});

Deno.test("discovery uses a scope team as the candidate source and verifies all team criteria", async () => {
  const client = new FakeGitHubClient({
    "/orgs/acme/teams/platform/repos?page=1&per_page=100": [[
      { name: "api", visibility: "private" },
      { name: "web", visibility: "private" },
    ]],
    "/orgs/acme/teams/security/repos?page=1&per_page=100": [[
      { name: "api", visibility: "private" },
    ]],
  });

  const repositories = await discoverRepositories(
    client,
    configuration({
      scope: { teams: ["platform", "security"] },
    }),
  );

  assertEquals(repositories, [{
    name: "api",
    visibility: "private",
    teams: ["platform", "security"],
    properties: {},
  }]);
});

Deno.test("discovery applies a single visibility as an organization-side filter", async () => {
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100&type=private": [[
      { name: "api", visibility: "private" },
    ]],
  });

  const repositories = await discoverRepositories(
    client,
    configuration({
      scope: { visibility: "private" },
    }),
  );

  assertEquals(repositories, [{
    name: "api",
    visibility: "private",
    teams: [],
    properties: {},
  }]);
});

Deno.test("discovery falls back to organization listing for name globs", async () => {
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100": [[
      { name: "api-service", visibility: "private" },
      { name: "website", visibility: "public" },
    ]],
  });

  const repositories = await discoverRepositories(
    client,
    configuration({
      scope: { names: ["api-*"] },
    }),
  );

  assertEquals(repositories, [{
    name: "api-service",
    visibility: "private",
    teams: [],
    properties: {},
  }]);
});

Deno.test("discovery hydrates only teams and custom properties referenced by selectors", async () => {
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100": [[
      { name: "api", visibility: "private" },
      { name: "web", visibility: "private" },
    ]],
    "/orgs/acme/teams/platform/repos?page=1&per_page=100": [[
      { name: "api", visibility: "private" },
    ]],
    "/orgs/acme/properties/values?page=1&per_page=100": [[
      {
        repository_name: "api",
        properties: [
          { property_name: "kind", value: "service" },
          { property_name: "ignored", value: "value" },
        ],
      },
      {
        repository_name: "web",
        properties: [
          { property_name: "kind", value: "website" },
        ],
      },
    ]],
  });

  const repositories = await discoverRepositories(
    client,
    configuration(
      { scope: {} },
      {
        code: {
          match: {
            teams: ["platform"],
            properties: { kind: "service" },
          },
        },
      },
    ),
  );

  assertEquals(repositories, [
    {
      name: "api",
      visibility: "private",
      teams: ["platform"],
      properties: { kind: "service" },
    },
    {
      name: "web",
      visibility: "private",
      teams: [],
      properties: { kind: "website" },
    },
  ]);
});

function configuration(
  root: { readonly scope: LoadedConfiguration["configuration"]["scope"] },
  templates: Readonly<Record<string, RepositoryTemplate>> = {},
): LoadedConfiguration {
  return {
    root: "/configuration",
    configuration: {
      version: 1,
      organization: "acme",
      scope: root.scope,
    },
    templates,
  };
}

function requestKey(
  path: string,
  query: Readonly<Record<string, GitHubQueryValue>>,
): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return path +
    (entries.length
      ? "?" + entries.map(([name, value]) => name + "=" + value).join("&")
      : "");
}
