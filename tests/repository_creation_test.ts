import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadConfigurationDirectory,
  preflightRepositoryCreation,
  type LoadedConfiguration,
  type RepositoryTemplate,
  type Scope,
  type RepositorySelector,
} from "../packages/octosmith/mod.ts";
import { main } from "../packages/cli/mod.ts";

Deno.test("creation preflight resolves explicit names and fixed selector choices", async () => {
  const loaded = configuration(
    {
      include: {
        names: ["api-*"],
        visibility: ["private", "internal"],
        teams: ["platform"],
        properties: { tier: "backend" },
      },
      exclude: { names: ["api-archived"] },
    },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["api-*"], visibility: "private" },
      }),
    },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "services",
    name: "api-service",
    visibility: "private",
    teams: ["security"],
    properties: { region: "us" },
  });

  assertEquals(result.template, "repository:services");
  assertEquals(result.ready, true);
  assertEquals(result.repository, {
    name: "api-service",
    teams: ["platform", "security"],
    visibility: "private",
    properties: { tier: "backend", region: "us" },
  });
  assertEquals(result.choices?.visibility, ["private"]);
  assertEquals(result.choices?.requiredTeams, ["platform"]);
  assertEquals(result.choices?.requiredProperties, { tier: "backend" });
});

Deno.test("creation preflight reports unresolved choices without using a witness", async () => {
  const loaded = configuration(
    {
      include: {
        names: ["team-*"],
        visibility: ["private", "internal"],
      },
      exclude: { names: ["team-secret-*"] },
    },
    {
      "repository:team": repositoryTemplate({
        include: { names: ["team-*"] },
      }),
    },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "repository:team",
  });

  assertEquals(result.ready, false);
  assertEquals(result.choices?.names.choices, undefined);
  assertEquals(result.choices?.names.includePatterns, [
    {
      path: "repositories.scope.include",
      patterns: ["team-*"],
    },
    {
      path: "templates.repository:team.match.include",
      patterns: ["team-*"],
    },
  ]);
  assertEquals(
    result.diagnostics.map(({ code }) => code),
    ["name_required", "visibility_required"],
  );
  assertEquals(JSON.stringify(result).includes("validation-repo"), false);
});

Deno.test("creation preflight rejects unreachable and conflicting constraints", async () => {
  const loaded = configuration(
    { include: { properties: { tier: "production" } } },
    {
      "repository:dev": repositoryTemplate({
        include: { properties: { tier: "development" } },
      }),
    },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "dev",
    name: "api",
  });

  assertEquals(result.ready, false);
  assertEquals(
    result.diagnostics.some(({ code }) => code === "template_unreachable"),
    true,
  );
  assertEquals(result.choices, undefined);
});

Deno.test("creation preflight rejects excluded and invalid explicit names", async () => {
  const loaded = configuration(
    { include: "all", exclude: { names: ["blocked-*"] } },
    { "repository:any": repositoryTemplate({ include: "all" }) },
  );

  const excluded = await preflightRepositoryCreation(loaded, {
    template: "any",
    name: "blocked-api",
    visibility: "private",
  });
  assertEquals(excluded.ready, false);
  assertEquals(
    excluded.diagnostics.some(({ code }) =>
      code === "name_outside_intersection"
    ),
    true,
  );

  const invalid = await preflightRepositoryCreation(loaded, {
    template: "any",
    name: "bad/name",
    visibility: "private",
  });
  assertEquals(invalid.ready, false);
  assertEquals(
    invalid.diagnostics.some(({ code }) => code === "invalid_name"),
    true,
  );
});

Deno.test("creation preflight rejects cross-template overlap for explicit metadata", async () => {
  const loaded = configuration(
    { include: "all" },
    {
      "repository:first": repositoryTemplate({ include: "all" }),
      "repository:second": repositoryTemplate({ include: "all" }),
    },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "first",
    name: "api",
    visibility: "private",
  });

  assertEquals(result.ready, false);
  assertEquals(
    result.diagnostics.some(({ code }) => code === "template_overlap"),
    true,
  );
});

Deno.test("creation preflight rejects custom property choices that conflict with selectors", async () => {
  const loaded = configuration(
    { include: { properties: { tier: "backend" } } },
    {
      "repository:backend": repositoryTemplate({ include: "all" }),
    },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "backend",
    name: "api",
    visibility: "private",
    properties: { tier: "frontend" },
  });

  assertEquals(result.ready, false);
  assertEquals(
    result.diagnostics.some(({ code }) => code === "property_conflict"),
    true,
  );
});

Deno.test("creation preflight validates templates composed from fragments", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.mkdir(join(root, "fragments"));
    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      JSON.stringify({
        version: 1,
        organization: "acme",
        repositories: {
          scope: {
            include: {
              names: ["api-*"],
              visibility: "private",
            },
          },
        },
      }),
    );
    await Deno.writeTextFile(
      join(root, "fragments", "base.yml"),
      JSON.stringify({
        version: 1,
        kind: "fragment",
        resource: "repository",
        repository: { settings: { has_issues: true } },
      }),
    );
    await Deno.writeTextFile(
      join(root, "templates", "services.yml"),
      JSON.stringify({
        version: 1,
        kind: "repository",
        match: { include: { names: ["api-*"] } },
        includes: ["../fragments/base.yml"],
        repository: {},
      }),
    );

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(
      loaded.templates["repository:services"].repository.settings?.hasIssues,
      true,
    );
    const result = await preflightRepositoryCreation(loaded, {
      template: "services",
      name: "api-service",
    });
    assertEquals(result.ready, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resource create CLI preflights offline and emits JSON diagnostics", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      JSON.stringify({
        version: 1,
        organization: "acme",
        repositories: {
          scope: {
            include: {
              names: ["api-*"],
              visibility: "private",
            },
          },
        },
      }),
    );
    await Deno.writeTextFile(
      join(root, "templates", "services.yml"),
      JSON.stringify({
        version: 1,
        kind: "repository",
        match: { include: { names: ["api-*"] } },
        repository: {},
      }),
    );

    const output: string[] = [];
    const errors: string[] = [];
    let networkCalls = 0;
    const exitCode = await main(
      [
        "resource",
        "create",
        "services",
        "--name",
        "api-service",
        "--path",
        root,
        "--format",
        "json",
      ],
      {
        credentials: {
          getEnv: () => {
            networkCalls++;
            return undefined;
          },
          runGhAuthToken: () => {
            networkCalls++;
            return Promise.reject(new Error("preflight must not invoke gh"));
          },
        },
        fetch: () => {
          networkCalls++;
          throw new Error("Preflight must not access GitHub");
        },
        write: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      },
    );

    assertEquals(exitCode, 0);
    assertEquals(JSON.parse(output.join("\n")).ready, true);
    assertEquals(errors, []);
    assertEquals(networkCalls, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function configuration(
  scope: Scope<RepositorySelector>,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): LoadedConfiguration {
  return {
    root: Deno.cwd(),
    configuration: {
      version: 1,
      organization: "acme",
      repositories: { scope },
    },
    templates,
  };
}

function repositoryTemplate(
  match: Scope<RepositorySelector>,
): RepositoryTemplate {
  return {
    version: 1,
    kind: "repository",
    match,
    repository: {},
  };
}
