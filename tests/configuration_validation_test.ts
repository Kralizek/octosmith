import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfigurationDirectory } from "../packages/octosmith/mod.ts";

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

Deno.test("configuration rejects misspelled scope selectors", async () => {
  await withConfiguration(
    {
      ...configuration,
      repositories: { scope: { include: { nmaes: ["sample"] } } },
    },
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
      match: { include: { nmaes: ["sample"] } },
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
