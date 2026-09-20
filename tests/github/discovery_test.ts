import { assertEquals, assertRejects } from "@std/assert";
import type {
  LoadedConfiguration,
  RepositoryTemplate,
} from "@octosmith/octosmith";
import {
  discoverRepositories,
  type GitHubClient,
  type GitHubQueryValue,
} from "@octosmith/octosmith";

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
    options: import("@octosmith/octosmith").GitHubRequestOptions = {},
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

Deno.test("targeted discovery fetches only the requested repository and selector metadata", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
    "/repos/acme/api/teams?page=1&per_page=100": [[{ slug: "platform" }]],
    "/repos/acme/api/properties/values": [[
      { property_name: "kind", value: "service" },
    ]],
  });

  const result = await discoverRepositories(
    client,
    configuration({
      scope: {
        teams: ["platform"],
        properties: { kind: "service" },
      },
    }),
    "api",
  );

  assertEquals(result, {
    repositories: [{
      name: "api",
      visibility: "private",
      teams: ["platform"],
      properties: { kind: "service" },
    }],
    failures: [],
  });
  assertEquals(client.requests.map(requestKeyFromRequest), [
    "/repos/acme/api",
    "/repos/acme/api/teams?page=1&per_page=100",
    "/repos/acme/api/properties/values",
  ]);
});

Deno.test("targeted discovery reads repository property values once", async () => {
  const propertyValues = Array.from({ length: 99 }, (_, index) => ({
    property_name: "unrelated-" + index,
    value: "value",
  }));
  propertyValues.push({ property_name: "kind", value: "service" });

  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
    "/repos/acme/api/properties/values": [propertyValues],
  });

  const result = await discoverRepositories(
    client,
    configuration({ scope: { properties: { kind: "service" } } }),
    "api",
  );

  assertEquals(result.repositories, [{
    name: "api",
    visibility: "private",
    teams: [],
    properties: { kind: "service" },
  }]);
  assertEquals(result.failures, []);
  assertEquals(client.requests.map(requestKeyFromRequest), [
    "/repos/acme/api",
    "/repos/acme/api/properties/values",
  ]);
});

Deno.test("targeted discovery rejects an empty repository target", async () => {
  const client = new FakeGitHubClient({});

  await assertRejects(
    () =>
      discoverRepositories(
        client,
        configuration({ scope: { names: ["*"] } }),
        "",
      ),
    Error,
    "Repository target must not be empty",
  );

  assertEquals(client.requests, []);
});

Deno.test("targeted discovery isolates selector metadata failures", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
  });

  const result = await discoverRepositories(
    client,
    configuration({ scope: { teams: ["platform"] } }),
    "api",
  );

  assertEquals(result.repositories, []);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0].repository, "api");
  assertEquals(
    result.failures[0].error instanceof Error
      ? result.failures[0].error.message
      : String(result.failures[0].error),
    "Unexpected request: /repos/acme/api/teams?page=1&per_page=100",
  );
});

Deno.test("targeted discovery reports repositories outside configured scope", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
  });

  const result = await discoverRepositories(
    client,
    configuration({ scope: { visibility: "public" } }),
    "api",
  );

  assertEquals(result.repositories, []);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0].repository, "api");
  assertEquals(
    result.failures[0].error instanceof Error
      ? result.failures[0].error.message
      : String(result.failures[0].error),
    "Repository api is outside the configured scope",
  );
  assertEquals(client.requests.map((request) => request.path), [
    "/repos/acme/api",
  ]);
});

Deno.test("discovery fetches exact repository names directly", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
    "/repos/acme/web": [{ name: "web", visibility: "public" }],
  });

  const repositories = await discoverRepositoryList(
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

  const repositories = await discoverRepositoryList(
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

Deno.test("discovery isolates failures for exact repository names", async () => {
  const client = new FakeGitHubClient({
    "/repos/acme/api": [{ name: "api", visibility: "private" }],
  });

  const result = await discoverRepositories(
    client,
    configuration({
      scope: { names: ["api", "missing"] },
    }),
  );

  assertEquals(result.repositories, [
    { name: "api", visibility: "private", teams: [], properties: {} },
  ]);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0].repository, "missing");
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

  const repositories = await discoverRepositoryList(
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

  const repositories = await discoverRepositoryList(
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

Deno.test("discovery narrows a one-item visibility array", async () => {
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100&type=private": [[
      { name: "api", visibility: "private" },
    ]],
  });

  const repositories = await discoverRepositoryList(
    client,
    configuration({
      scope: { visibility: ["private"] },
    }),
  );

  assertEquals(repositories, [{
    name: "api",
    visibility: "private",
    teams: [],
    properties: {},
  }]);
});

Deno.test("discovery does not send unsupported internal visibility filtering", async () => {
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100": [[
      { name: "internal-api", visibility: "internal" },
      { name: "private-api", visibility: "private" },
    ]],
  });

  const repositories = await discoverRepositoryList(
    client,
    configuration({
      scope: { visibility: "internal" },
    }),
  );

  assertEquals(repositories, [{
    name: "internal-api",
    visibility: "internal",
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

  const repositories = await discoverRepositoryList(
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

  const repositories = await discoverRepositoryList(
    client,
    configuration(
      { scope: {} },
      {
        code: {
          kind: "repository",
          match: {
            teams: ["platform"],
            properties: { kind: "service" },
          },
          repository: {},
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

Deno.test("discovery finds a matching repository on organization page two", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: "repo-" + index,
    visibility: "private",
  }));
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100": [firstPage],
    "/orgs/acme/repos?page=2&per_page=100": [[
      { name: "target-api", visibility: "private" },
    ]],
  });

  const repositories = await discoverRepositoryList(
    client,
    configuration({ scope: { names: ["target-*"] } }),
  );

  assertEquals(repositories.map((repository) => repository.name), [
    "target-api",
  ]);
});

Deno.test("discovery follows team membership pagination", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: "repo-" + index,
    visibility: "private",
  }));
  const client = new FakeGitHubClient({
    "/orgs/acme/teams/platform/repos?page=1&per_page=100": [firstPage],
    "/orgs/acme/teams/platform/repos?page=2&per_page=100": [[
      { name: "api", visibility: "private" },
    ]],
  });

  const repositories = await discoverRepositoryList(
    client,
    configuration({ scope: { teams: ["platform"] } }),
  );

  assertEquals(repositories.length, 101);
  assertEquals(
    repositories.find((repository) => repository.name === "api"),
    {
      name: "api",
      visibility: "private",
      teams: ["platform"],
      properties: {},
    },
  );
});

Deno.test("discovery uses custom properties from page two for selection", async () => {
  const firstPropertyPage = Array.from({ length: 100 }, (_, index) => ({
    repository_name: "other-" + index,
    properties: [{ property_name: "kind", value: "other" }],
  }));
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100": [[
      { name: "api", visibility: "private" },
    ]],
    "/orgs/acme/properties/values?page=1&per_page=100": [firstPropertyPage],
    "/orgs/acme/properties/values?page=2&per_page=100": [[
      {
        repository_name: "api",
        properties: [{ property_name: "kind", value: "service" }],
      },
    ]],
  });

  const repositories = await discoverRepositoryList(
    client,
    configuration({
      scope: { properties: { kind: "service" } },
    }),
  );

  assertEquals(repositories, [{
    name: "api",
    visibility: "private",
    teams: [],
    properties: { kind: "service" },
  }]);
});

Deno.test("discovery requests an empty page after exactly 100 results", async () => {
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    name: "repo-" + index,
    visibility: "private",
  }));
  const client = new FakeGitHubClient({
    "/orgs/acme/repos?page=1&per_page=100": [repositories],
    "/orgs/acme/repos?page=2&per_page=100": [[]],
  });

  const discovered = await discoverRepositoryList(
    client,
    configuration({ scope: {} }),
  );

  assertEquals(discovered.length, 100);
  assertEquals(
    new Set(discovered.map((repository) => repository.name)).size,
    100,
  );
  assertEquals(client.requests.length, 2);
  assertEquals(client.requests.map(requestKeyFromRequest), [
    "/orgs/acme/repos?page=1&per_page=100",
    "/orgs/acme/repos?page=2&per_page=100",
  ]);
});

function requestKeyFromRequest(request: Request): string {
  return requestKey(request.path, request.query);
}

async function discoverRepositoryList(
  client: GitHubClient,
  loaded: LoadedConfiguration,
) {
  return (await discoverRepositories(client, loaded)).repositories;
}

function configuration(
  root: {
    readonly scope:
      LoadedConfiguration["configuration"]["repositories"]["scope"];
  },
  templates: Readonly<Record<string, RepositoryTemplate>> = {},
): LoadedConfiguration {
  return {
    root: "/configuration",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: { scope: root.scope },
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
