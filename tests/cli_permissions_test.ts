import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  aggregateGitHubPermissionRequirements,
  loadConfigurationDirectory,
  requiredPermissionsForConfiguration,
} from "../packages/octosmith/mod.ts";
import { main } from "../packages/cli/mod.ts";

async function configuration(mode: "explicit" | "strict" = "explicit") {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await Deno.mkdir(root + "/fragments");
  await Deno.writeTextFile(
    root + "/octosmith.yml",
    `version: 1
organization: acme
repositories:
  scope:
    include: all
  settings:
    collection_management: ${mode}
`,
  );
  await Deno.writeTextFile(
    root + "/fragments/shared.yml",
    `version: 1
kind: fragment
resource: repository
repository:
  teams:
    - name: developers
      permission: push
  actions:
    oidc:
      immutable_subject: true
`,
  );
  await Deno.writeTextFile(
    root + "/templates/first.yml",
    `version: 1
kind: repository
match:
  include:
    names: [first]
includes: [../fragments/shared.yml]
repository:
  settings:
    description: Managed
  files:
    absent.txt:
      ensure: absent
`,
  );
  await Deno.writeTextFile(
    root + "/templates/second.yml",
    `version: 1
kind: repository
match:
  include:
    names: [second]
repository:
  actions:
    secrets: []
  dependabot:
    secrets: []
  rulesets: []
  environments: []
`,
  );
  return root;
}

Deno.test("permission analysis is offline, composed and structured", async () => {
  const root = await configuration();
  const output: string[] = [];
  const originalFetch = globalThis.fetch;
  const previous = Deno.env.get("GITHUB_TOKEN");
  let calls = 0;
  try {
    Deno.env.delete("GITHUB_TOKEN");
    globalThis.fetch = ((_input, _init) => {
      calls++;
      throw new Error("Unexpected GitHub request");
    }) as typeof globalThis.fetch;
    assertEquals(
      await main(
        ["template", "permissions", "--path", root, "--format", "json"],
        { write: (text) => output.push(text) },
      ),
      0,
    );
    assertEquals(calls, 0);
    assertEquals(JSON.parse(output[0]), {
      requirements: [
        { scope: "organization", permission: "members", access: "read" },
        { scope: "repository", permission: "actions", access: "write" },
        { scope: "repository", permission: "administration", access: "write" },
        { scope: "repository", permission: "contents", access: "write" },
        { scope: "repository", permission: "issues", access: "write" },
        { scope: "repository", permission: "metadata", access: "read" },
        { scope: "repository", permission: "pull_requests", access: "write" },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) Deno.env.delete("GITHUB_TOKEN");
    else Deno.env.set("GITHUB_TOKEN", previous);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("single template text output excludes other templates and groups scopes", async () => {
  const root = await configuration();
  const output: string[] = [];
  try {
    assertEquals(
      await main(
        ["template", "permissions", "first", "-p", root],
        { write: (text) => output.push(text) },
      ),
      0,
    );
    assertStringIncludes(output[0], "Repository permissions:");
    assertStringIncludes(output[0], "Organization permissions:");
    assertStringIncludes(output[0], "Members (members): read");
    assertEquals(output[0].includes("Dependabot secrets"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("strict empty collections can remove resources; explicit cannot", async () => {
  const explicit = await configuration();
  const strict = await configuration("strict");
  try {
    const sparse = requiredPermissionsForConfiguration(
      await loadConfigurationDirectory(explicit),
      "second",
    );
    assertEquals(sparse, []);
    const authoritative = requiredPermissionsForConfiguration(
      await loadConfigurationDirectory(strict),
      "second",
    );
    assertEquals(authoritative, [
      { scope: "repository", permission: "administration", access: "write" },
      {
        scope: "repository",
        permission: "dependabot_secrets",
        access: "write",
      },
      { scope: "repository", permission: "secrets", access: "write" },
    ]);
  } finally {
    await Deno.remove(explicit, { recursive: true });
    await Deno.remove(strict, { recursive: true });
  }
});

Deno.test("direct file delivery excludes pull request permissions", async () => {
  const root = await configuration();
  try {
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      `version: 1
organization: acme
repositories:
  scope:
    include: all
  file_changes:
    mode: direct
`,
    );
    const requirements = requiredPermissionsForConfiguration(
      await loadConfigurationDirectory(root),
      "first",
    );
    assertEquals(
      requirements.some((item) => item.permission === "contents"),
      true,
    );
    assertEquals(
      requirements.some((item) =>
        item.permission === "pull_requests" || item.permission === "issues"
      ),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("templates outside configuration scope contribute no permissions", async () => {
  const root = await configuration();
  try {
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      `version: 1
organization: acme
repositories:
  scope:
    include:
      names: [second]
`,
    );
    assertEquals(
      requiredPermissionsForConfiguration(
        await loadConfigurationDirectory(root),
      ),
      [],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unknown template fails clearly", async () => {
  const root = await configuration();
  const errors: string[] = [];
  try {
    assertEquals(
      await main(
        ["template", "permissions", "missing", "--path", root],
        { writeError: (text) => errors.push(text) },
      ),
      1,
    );
    assertStringIncludes(errors.join("\n"), "Unknown template: missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("aggregation retains strongest access for a scoped permission", () => {
  assertEquals(
    aggregateGitHubPermissionRequirements([
      { scope: "repository", permission: "metadata", access: "read" },
      { scope: "repository", permission: "metadata", access: "write" },
      { scope: "repository", permission: "metadata", access: "read" },
      { scope: "organization", permission: "members", access: "read" },
    ]),
    [
      { scope: "organization", permission: "members", access: "read" },
      { scope: "repository", permission: "metadata", access: "write" },
    ],
  );
});
