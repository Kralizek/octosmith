import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  effectiveRepositorySelectorIntersection,
  loadConfigurationDirectory,
  matchesEffectiveRepositorySelectorIntersection,
  templateCanMatchScope,
} from "../packages/octosmith/mod.ts";

const configuration = {
  version: 1,
  organization: "acme",
  repositories: { scope: { include: { names: ["sample"] } } },
};
const template = {
  version: 1,
  kind: "repository",
  match: { include: { names: ["*"] } },
  repository: {},
};

Deno.test("effective selector intersection matches candidates with exclusions", () => {
  const intersection = effectiveRepositorySelectorIntersection(
    {
      include: {
        names: ["team-*"],
        visibility: ["private", "internal"],
      },
      exclude: { names: ["team-secret-*"] },
    },
    {
      version: 1,
      kind: "repository",
      match: {
        include: {
          names: ["team-api", "team-secret-api"],
          visibility: "private",
          teams: ["platform"],
          properties: { tier: "backend" },
        },
        exclude: { properties: { status: "archived" } },
      },
      repository: {},
    },
    "repository:team",
  );
  const candidate = {
    name: "team-api",
    teams: ["platform"],
    visibility: "private" as const,
    properties: { tier: "backend", status: "active" },
  };

  assertEquals(intersection.reachable, true);
  if (intersection.effective === undefined) {
    throw new Error(
      "Expected effective constraints for a reachable intersection",
    );
  }
  const effective = intersection.effective;
  assertEquals(effective.names.choices, ["team-api"]);
  assertEquals(intersection.semanticWitness?.name, "team-api");
  assertEquals(effective.names.includePatterns, [
    {
      path: "repositories.scope.include",
      patterns: ["team-*"],
    },
    {
      path: "templates.repository:team.match.include",
      patterns: ["team-api", "team-secret-api"],
    },
  ]);
  assertEquals(effective.names.excludeConstraints.length, 2);
  assertEquals(effective.visibility, ["private"]);
  assertEquals(effective.requiredTeams, ["platform"]);
  assertEquals(effective.requiredProperties, { tier: "backend" });
  assertEquals(
    matchesEffectiveRepositorySelectorIntersection(intersection, candidate),
    true,
  );
  assertEquals(
    matchesEffectiveRepositorySelectorIntersection(intersection, {
      ...candidate,
      name: "team-secret-api",
    }),
    false,
  );
  assertEquals(
    matchesEffectiveRepositorySelectorIntersection(intersection, {
      ...candidate,
      properties: { tier: "backend", status: "archived" },
    }),
    false,
  );
  assertEquals(
    matchesEffectiveRepositorySelectorIntersection(intersection, {
      ...candidate,
      visibility: "public",
    }),
    false,
  );
});

Deno.test("wildcard name intersections expose patterns, not semantic witnesses as choices", () => {
  for (
    const [scopeNames, templateNames, expectedCandidate, rejectedCandidate] of [
      ["*", "*", "ordinary-repository", "reserved-repository"],
      ["team-*", "team-?", "team-a", "team-api"],
    ] as const
  ) {
    const intersection = effectiveRepositorySelectorIntersection(
      {
        include: { names: [scopeNames] },
        exclude: scopeNames === "*" ? { names: ["reserved-*"] } : undefined,
      },
      {
        version: 1,
        kind: "repository",
        match: { include: { names: [templateNames] } },
        repository: {},
      },
      "repository:wildcard",
    );

    assertEquals(intersection.reachable, true);
    assertEquals(intersection.effective?.names.choices, undefined);
    assertEquals(intersection.effective?.names.includePatterns.length, 2);
    assertEquals(
      intersection.effective?.names.excludeConstraints.length,
      scopeNames === "*" ? 1 : 0,
    );
    assertEquals(
      matchesEffectiveRepositorySelectorIntersection(intersection, {
        name: expectedCandidate,
        teams: [],
        visibility: "private",
        properties: {},
      }),
      true,
    );
    assertEquals(
      matchesEffectiveRepositorySelectorIntersection(intersection, {
        name: rejectedCandidate,
        teams: [],
        visibility: "private",
        properties: {},
      }),
      false,
    );
  }
});

Deno.test("template reachability checks include selectors without deriving choices", () => {
  const template = {
    version: 1,
    kind: "repository",
    match: {
      include: {
        names: ["team-api"],
        visibility: "private",
        teams: ["platform"],
        properties: { tier: "backend" },
      },
    },
    repository: {},
  } as const;

  assertEquals(
    templateCanMatchScope(
      {
        include: { names: ["team-*"], visibility: ["private", "internal"] },
        exclude: { names: ["team-secret-*"] },
      },
      template,
    ),
    true,
  );
  assertEquals(
    templateCanMatchScope(
      {
        include: { names: ["team-*"] },
        exclude: { names: ["team-api"] },
      },
      template,
    ),
    false,
  );
  assertEquals(
    templateCanMatchScope(
      {
        include: { properties: { tier: "frontend" } },
      },
      template,
    ),
    false,
  );
});

Deno.test("configuration rejects misspelled scope selectors", async () => {
  await withConfiguration(
    { ...configuration, repositories: { scope: { nmaes: ["sample"] } } },
    template,
    async (root) => {
      const error = await assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "nmaes",
      );
      assertStringIncludes(error.message, "octosmith.yml");
      assertStringIncludes(error.message, "/repositories/scope");
    },
  );
});

Deno.test("configuration rejects an empty scope", async () => {
  await withConfiguration(
    { ...configuration, repositories: { scope: {} } },
    template,
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "/repositories/scope",
      ),
  );
});

Deno.test("configuration rejects missing template kind", async () => {
  await withConfiguration(
    configuration,
    { match: { include: { names: ["*"] } }, repository: {} },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "kind",
      ),
  );
});

Deno.test("configuration rejects unsupported template kind", async () => {
  await withConfiguration(
    configuration,
    {
      kind: "organization",
      match: { include: { names: ["*"] } },
      repository: {},
    },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "kind",
      ),
  );
});

Deno.test("configuration accepts include all", async () => {
  await withConfiguration(
    {
      version: 1,
      organization: "acme",
      repositories: { scope: { include: "all" } },
    },
    {
      version: 1,
      kind: "repository",
      match: { include: "all", exclude: { names: ["legacy-*"] } },
      repository: {},
    },
    async (root) => {
      const loaded = await loadConfigurationDirectory(root);
      assertEquals(loaded.configuration.repositories.scope.include, "all");
      assertEquals(
        loaded.templates["repository:code"].match.include,
        "all",
      );
    },
  );
});

Deno.test("configuration rejects repository template without repository body", async () => {
  await withConfiguration(
    configuration,
    { version: 1, kind: "repository", match: { include: { names: ["*"] } } },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "repository",
      ),
  );
});

Deno.test("configuration accepts Actions and Dependabot value blocks", async () => {
  await withConfiguration(
    configuration,
    {
      version: 1,
      kind: "repository",
      match: { include: { names: ["*"] } },
      repository: {
        actions: {
          secrets: [
            "DEPLOY_TOKEN",
            { from: "EXTERNAL_TOKEN", to: "IMPORTED_TOKEN" },
          ],
          variables: [
            "REGION",
            { from: "EXTERNAL_REGION", to: "IMPORTED_REGION" },
            { name: "STATIC_REGION", value: "eu-north-1" },
          ],
        },
        dependabot: {
          secrets: [
            "NUGET_FEED_TOKEN",
            { from: "EXTERNAL_NUGET_TOKEN", to: "IMPORTED_NUGET_TOKEN" },
          ],
        },
        environments: [{
          name: "production",
          secrets: [
            "DEPLOY_TOKEN",
            { from: "EXTERNAL_ENV_TOKEN", to: "IMPORTED_ENV_TOKEN" },
          ],
          variables: [
            "REGION",
            { from: "EXTERNAL_ENV_REGION", to: "IMPORTED_ENV_REGION" },
            { name: "STATIC_ENV_REGION", value: "eu-west-1" },
          ],
        }],
      },
    },
    async (root) => {
      await loadConfigurationDirectory(root);
    },
  );
});

Deno.test("configuration rejects unsupported versions", async () => {
  await withConfiguration(
    { ...configuration, version: 2 },
    template,
    (root) =>
      assertRejects(() => loadConfigurationDirectory(root), Error, "/version"),
  );
});

Deno.test("configuration rejects empty file_changes", async () => {
  await withConfiguration(
    {
      ...configuration,
      repositories: {
        scope: { include: { names: ["sample"] } },
        file_changes: {},
      },
    },
    template,
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "/repositories/file_changes",
      ),
  );
});

Deno.test("configuration rejects pull_request settings in direct mode", async () => {
  await withConfiguration(
    {
      ...configuration,
      repositories: {
        scope: { include: { names: ["sample"] } },
        file_changes: {
          mode: "direct",
          pull_request: { title: "Not allowed" },
        },
      },
    },
    template,
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "pull_request",
      ),
  );
});

Deno.test("configuration rejects misspelled template selectors", async () => {
  await withConfiguration(
    configuration,
    {
      version: 1,
      kind: "repository",
      match: { nmaes: ["sample"] },
      repository: {},
    },
    async (root) => {
      const error = await assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "nmaes",
      );
      assertStringIncludes(error.message, "code.yml");
    },
  );
});

Deno.test("configuration rejects invalid setting types without echoing values", async () => {
  await withConfiguration(configuration, {
    ...template,
    repository: { settings: { has_issues: "private-runtime-value" } },
  }, async (root) => {
    const error = await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "/repository/settings/has_issues",
    );
    assertEquals(error.message.includes("private-runtime-value"), false);
  });
});

Deno.test("configuration rejects unknown file ensure values", async () => {
  await withConfiguration(
    configuration,
    {
      ...template,
      repository: { files: { "README.md": { ensure: "absnet" } } },
    },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "/repository/files/README.md",
      ),
  );
});

async function withConfiguration(
  rootConfiguration: unknown,
  repositoryTemplate: unknown,
  run: (root: string) => Promise<unknown>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      JSON.stringify(rootConfiguration),
    );
    await Deno.writeTextFile(
      join(root, "templates", "code.yml"),
      JSON.stringify(repositoryTemplate),
    );
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
