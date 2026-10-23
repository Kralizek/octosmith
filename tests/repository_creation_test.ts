import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadConfigurationDirectory,
  type LoadedConfiguration,
  preflightRepositoryCreation,
  type RepositorySelector,
  type RepositoryTemplate,
  type Scope,
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
  assertEquals(result.choices?.visibility.value, "private");
  assertEquals(result.choices?.visibility.alternatives, ["private"]);
  assertEquals(result.choices?.teams, ["platform"]);
  assertEquals(result.choices?.customProperties, {
    tier: "backend",
    region: "us",
  });
});

Deno.test("creation preflight reports unresolved choices without using a witness", async () => {
  const loaded = configuration(
    {
      include: {
        names: ["team-*", "service-*"],
        visibility: ["private", "internal"],
      },
      exclude: { names: ["team-secret-*"] },
    },
    {
      "repository:team": repositoryTemplate({
        include: "all",
      }),
    },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "repository:team",
  });

  assertEquals(result.ready, false);
  assertEquals(result.choices?.name.status, "ambiguous");
  assertEquals(result.choices?.name.alternatives, [
    { pattern: "service-*" },
    { pattern: "team-*" },
  ]);
  assertEquals(result.choices?.visibility.status, "ambiguous");
  assertEquals(
    result.diagnostics.map(({ code }) => code),
    ["visibility_ambiguous", "ambiguous_name_strategy"],
  );
  assertEquals(JSON.stringify(result).includes("validation-repo"), false);
});

Deno.test("creation preflight intersects naming patterns before generating a name", async () => {
  const loaded = configuration(
    { include: { names: ["team-*-svcs"], visibility: "private" } },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-prod-*-svcs"] },
      }),
    },
  );
  const generated = ["k7m2x9"];
  let randomCalls = 0;
  const result = await preflightRepositoryCreation(
    loaded,
    { template: "services" },
    {
      randomBytes: (length) => {
        randomCalls++;
        const value = generated.shift()!;
        const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        return Uint8Array.from(
          value.slice(0, length).split("").map((character) =>
            alphabet.indexOf(character)
          ),
        );
      },
    },
  );

  assertEquals(result.ready, true);
  assertEquals(result.repository?.name, "team-prod-k7m2x9-svcs");
  assertEquals(randomCalls, 1);
});

Deno.test("creation preflight generates each star as an independent six-character segment", async () => {
  const loaded = configuration(
    { include: { names: ["team-*-*-svcs"], visibility: "private" } },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-*-*-svcs"] },
      }),
    },
  );
  const generated = ["k7m2x9", "a1b2c3"];
  const result = await preflightRepositoryCreation(
    loaded,
    { template: "services" },
    {
      randomBytes: (length) => {
        const value = generated.shift()!;
        const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        return Uint8Array.from(
          value.slice(0, length).split("").map((character) =>
            alphabet.indexOf(character)
          ),
        );
      },
    },
  );

  assertEquals(result.ready, true);
  assertEquals(result.repository?.name, "team-k7m2x9-a1b2c3-svcs");
});

Deno.test("creation preflight supports ? and multiple independent wildcard segments", async () => {
  const loaded = configuration(
    { include: { names: ["team-?-*-svcs"], visibility: "private" } },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-?-*-svcs"] },
      }),
    },
  );
  const generated = ["k", "7m2x9a"];
  const result = await preflightRepositoryCreation(
    loaded,
    { template: "services" },
    {
      randomBytes: (length) => {
        const value = generated.shift()!;
        const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        return Uint8Array.from(
          value.slice(0, length).split("").map((character) =>
            alphabet.indexOf(character)
          ),
        );
      },
    },
  );

  assertEquals(result.ready, true);
  assertEquals(result.repository?.name, "team-k-7m2x9a-svcs");
});

Deno.test("creation preflight retries excluded names and reports bounded failure", async () => {
  const loaded = configuration(
    {
      include: { names: ["team-*-svcs"], visibility: "private" },
      exclude: { names: ["team-aaaaaa-svcs"] },
    },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-*-svcs"] },
      }),
    },
  );
  let attempt = 0;
  const retried = await preflightRepositoryCreation(
    loaded,
    { template: "services" },
    {
      maxNameAttempts: 2,
      randomBytes: (length) => {
        const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        const value = attempt++ === 0 ? "aaaaaa" : "k7m2x9";
        return Uint8Array.from(
          value.slice(0, length).split("").map((character) =>
            alphabet.indexOf(character)
          ),
        );
      },
    },
  );

  assertEquals(retried.ready, true);
  assertEquals(retried.repository?.name, "team-k7m2x9-svcs");
  assertEquals(attempt, 2);

  const fullyExcluded = configuration(
    {
      include: { names: ["team-*-svcs"], visibility: "private" },
      exclude: { names: ["team-??????-svcs"] },
    },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-*-svcs"] },
      }),
    },
  );
  const rejected = await preflightRepositoryCreation(
    fullyExcluded,
    { template: "services" },
    {
      maxNameAttempts: 3,
      randomBytes: (length) => new Uint8Array(length),
    },
  );
  assertEquals(rejected.ready, false);
  assertEquals(rejected.choices.name.status, "generation_failed");
  assertEquals(
    rejected.diagnostics.some(({ code }) => code === "name_generation_failed"),
    true,
  );
});

Deno.test("creation preflight does not generate a name while visibility is ambiguous", async () => {
  const loaded = configuration(
    {
      include: {
        names: ["team-*-svcs"],
        visibility: ["private", "internal"],
      },
    },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-*-svcs"] },
      }),
    },
  );
  let randomCalls = 0;
  const result = await preflightRepositoryCreation(
    loaded,
    { template: "services" },
    {
      randomBytes: (length) => {
        randomCalls++;
        return new Uint8Array(length);
      },
    },
  );

  assertEquals(result.ready, false);
  assertEquals(result.choices.name.status, "unresolved");
  assertEquals(result.choices.name.alternatives, [
    { pattern: "team-*-svcs" },
  ]);
  assertEquals(randomCalls, 0);
});

Deno.test("creation preflight accepts explicit name and visibility to resolve ambiguities", async () => {
  const loaded = configuration(
    {
      include: {
        names: ["team-*", "service-*"],
        visibility: ["private", "internal"],
      },
    },
    {
      "repository:services": repositoryTemplate({ include: "all" }),
    },
  );
  let randomCalls = 0;
  const result = await preflightRepositoryCreation(
    loaded,
    { template: "services", name: "team-api", visibility: "internal" },
    {
      randomBytes: (length) => {
        randomCalls++;
        return new Uint8Array(length);
      },
    },
  );

  assertEquals(result.ready, true);
  assertEquals(result.choices.name.status, "explicit");
  assertEquals(result.choices.visibility.value, "internal");
  assertEquals(randomCalls, 0);
});

Deno.test("creation preflight handles visibility ambiguity and template settings", async () => {
  const multiple = configuration(
    {
      include: {
        names: ["team-*"],
        visibility: ["private", "internal"],
      },
    },
    {
      "repository:services": repositoryTemplate({
        include: { names: ["team-*"] },
      }),
    },
  );
  const ambiguous = await preflightRepositoryCreation(
    multiple,
    { template: "services", name: "team-api" },
  );
  assertEquals(ambiguous.ready, false);
  assertEquals(ambiguous.choices.visibility.alternatives, [
    "private",
    "internal",
  ]);
  assertEquals(
    ambiguous.diagnostics.some(({ code }) => code === "visibility_ambiguous"),
    true,
  );

  const selected = await preflightRepositoryCreation(
    multiple,
    { template: "services", name: "team-api", visibility: "internal" },
  );
  assertEquals(selected.ready, true);

  const invalidVisibility = await preflightRepositoryCreation(multiple, {
    template: "services",
    name: "team-api",
    visibility: "secret",
  });
  assertEquals(invalidVisibility.ready, false);
  assertEquals(
    invalidVisibility.diagnostics.some(({ code }) =>
      code === "invalid_visibility"
    ),
    true,
  );

  const managed = configuration(
    {
      include: {
        names: ["team-*"],
        visibility: ["private", "internal"],
      },
    },
    {
      "repository:services": {
        ...repositoryTemplate({ include: { names: ["team-*"] } }),
        repository: { settings: { visibility: "internal" } },
      },
    },
  );
  const resolvedManaged = await preflightRepositoryCreation(managed, {
    template: "services",
    name: "team-api",
  });
  assertEquals(resolvedManaged.ready, true);
  assertEquals(resolvedManaged.choices.visibility.value, "internal");

  const conflicting = configuration(
    {
      include: {
        names: ["team-*"],
        visibility: "public",
      },
    },
    {
      "repository:services": {
        ...repositoryTemplate({ include: { names: ["team-*"] } }),
        repository: { settings: { visibility: "private" } },
      },
    },
  );
  const rejected = await preflightRepositoryCreation(conflicting, {
    template: "services",
    name: "team-api",
  });
  assertEquals(rejected.ready, false);
  assertEquals(
    rejected.diagnostics.some(({ code }) =>
      code === "incompatible_constraints"
    ),
    true,
  );

  const explicitConflict = await preflightRepositoryCreation(managed, {
    template: "services",
    name: "team-api",
    visibility: "private",
  });
  assertEquals(explicitConflict.ready, false);
  assertEquals(
    explicitConflict.diagnostics.some(({ code }) =>
      code === "incompatible_constraints"
    ),
    true,
  );
});

Deno.test("creation preflight requires a name when selectors do not constrain naming", async () => {
  const loaded = configuration(
    { include: "all" },
    { "repository:any": repositoryTemplate({ include: "all" }) },
  );

  const result = await preflightRepositoryCreation(loaded, {
    template: "any",
  });

  assertEquals(result.ready, false);
  assertEquals(result.choices.name.status, "required");
  assertEquals(
    result.diagnostics.some(({ code }) => code === "name_required"),
    true,
  );
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
  assertEquals(result.choices.name.status, "unresolved");
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
      code === "metadata_outside_intersection"
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
        repository: {
          settings: { has_issues: true, visibility: "private" },
        },
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
    assertEquals(result.repository?.visibility, "private");
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
        "--visibility",
        "private",
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
    const specification = JSON.parse(output.join("\n"));
    assertEquals(specification.ready, true);
    assertEquals(specification.choices.visibility.value, "private");
    assertEquals(errors, []);
    assertEquals(networkCalls, 0);

    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      JSON.stringify({
        version: 1,
        organization: "acme",
        repositories: {
          scope: {
            include: {
              names: ["api-*"],
              visibility: ["private", "internal"],
            },
          },
        },
      }),
    );
    output.length = 0;
    errors.length = 0;
    assertEquals(
      await main(
        [
          "resource",
          "create",
          "services",
          "--path",
          root,
        ],
        {
          credentials: {
            getEnv: () => {
              networkCalls++;
              throw new Error("preflight must not read credentials");
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
      ),
      1,
    );
    assertEquals(output, []);
    assertEquals(
      errors.join("\n").includes("--visibility <private|internal>"),
      true,
    );
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
