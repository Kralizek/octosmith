import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadConfigurationDirectory,
  resolveDesiredState,
} from "../packages/core/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CONFIGURATION_ROOT = join(ROOT, "examples", "configuration");
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures", "configuration");

Deno.test("loads example configuration and templates", async () => {
  const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);

  assertEquals(loaded.configuration, {
    version: 1,
    organization: "example-org",
    scope: {
      teams: ["platform-team"],
    },
  });

  assertEquals(Object.keys(loaded.templates).sort(), [
    "code",
    "config",
    "infrastructure",
    "issues",
    "shared-library",
  ]);

  assertEquals(
    loaded.templates.code.repository?.settings?.deleteBranchOnMerge,
    true,
  );
  assertEquals(
    loaded.templates.code.rulesets?.[0].conditions?.refName?.include,
    ["~DEFAULT_BRANCH"],
  );
});

for (
  const repository of [
    "api-service",
    "terraform-networking",
    "shared-library",
    "issue-tracker",
    "config-repository",
  ]
) {
  Deno.test(
    "resolves " + repository + " to its golden DesiredState",
    async () => {
      const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);
      const metadata = JSON.parse(
        await Deno.readTextFile(
          join(FIXTURE_ROOT, "repositories", repository + ".json"),
        ),
      );
      const expected = JSON.parse(
        await Deno.readTextFile(
          join(FIXTURE_ROOT, "expected", repository + ".json"),
        ),
      );

      const desired = await resolveDesiredState(
        loaded,
        metadata,
        (name) => name + "-value",
      );

      assertEquals(desired, expected);
    },
  );
}

Deno.test("fixture organization agrees with root configuration", async () => {
  const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);
  const organization = JSON.parse(
    await Deno.readTextFile(join(FIXTURE_ROOT, "organization.json")),
  );

  assertEquals(organization.organization, loaded.configuration.organization);
});
