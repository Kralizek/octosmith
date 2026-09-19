import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfigurationDirectory } from "../packages/core/mod.ts";

const configuration = {
  version: 1,
  organization: "acme",
  repositories: { scope: { names: ["sample"] } },
};
const template = {
  kind: "repository",
  match: { names: ["*"] },
  repository: {},
};

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

Deno.test("configuration rejects legacy top-level scope", async () => {
  await withConfiguration(
    {
      version: 1,
      organization: "acme",
      scope: { names: ["sample"] },
    },
    template,
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "scope",
      ),
  );
});

Deno.test("configuration rejects missing template kind", async () => {
  await withConfiguration(
    configuration,
    { match: { names: ["*"] }, repository: {} },
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
    { kind: "organization", match: { names: ["*"] }, repository: {} },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "kind",
      ),
  );
});

Deno.test("configuration rejects repository template without repository body", async () => {
  await withConfiguration(
    configuration,
    { kind: "repository", match: { names: ["*"] } },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "repository",
      ),
  );
});

Deno.test("configuration rejects legacy top-level repository resource fields", async () => {
  await withConfiguration(
    configuration,
    {
      kind: "repository",
      match: { names: ["*"] },
      repository: {},
      rulesets: [],
    },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "rulesets",
      ),
  );
});

Deno.test("configuration rejects legacy top-level environments", async () => {
  await withConfiguration(
    configuration,
    {
      kind: "repository",
      match: { names: ["*"] },
      repository: {},
      environments: [],
    },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "environments",
      ),
  );
});

Deno.test("configuration rejects legacy top-level files", async () => {
  await withConfiguration(
    configuration,
    {
      kind: "repository",
      match: { names: ["*"] },
      repository: {},
      files: {},
    },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "files",
      ),
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

Deno.test("configuration rejects misspelled template selectors", async () => {
  await withConfiguration(
    configuration,
    { kind: "repository", match: { nmaes: ["sample"] }, repository: {} },
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

Deno.test("configuration rejects unknown file reconciliation modes", async () => {
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
