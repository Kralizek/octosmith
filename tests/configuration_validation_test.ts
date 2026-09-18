import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { loadConfigurationDirectory } from "../packages/core/mod.ts";

const configuration = {
  version: 1,
  organization: "acme",
  scope: { names: ["sample"] },
};
const template = { match: { names: ["*"] } };

Deno.test("configuration rejects misspelled scope selectors", async () => {
  await withConfiguration(
    { ...configuration, scope: { nmaes: ["sample"] } },
    template,
    async (root) => {
      const error = await assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "nmaes",
      );
      assertStringIncludes(error.message, "octosmith.yml");
      assertStringIncludes(error.message, "/scope");
    },
  );
});

Deno.test("configuration rejects an empty scope", async () => {
  await withConfiguration(
    { ...configuration, scope: {} },
    template,
    (root) =>
      assertRejects(() => loadConfigurationDirectory(root), Error, "/scope"),
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
    { match: { nmaes: ["sample"] } },
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
      files: { "README.md": { ensure: "absnet" } },
    },
    (root) =>
      assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "/files/README.md",
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
