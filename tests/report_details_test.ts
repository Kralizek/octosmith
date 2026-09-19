import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  type Operation,
  renderReport,
  reportPlannedRepository,
} from "@octosmith/core";

Deno.test("destructive plans identify every removed resource", () => {
  const rendered = render([
    { type: "delete-environment", name: "production" },
    { type: "delete-file", path: ".github/workflows/build.yml", sha: "sha" },
    { type: "delete-ruleset", id: 42, name: "branch-protection" },
    { type: "remove-team-permission", team: "maintainers" },
    { type: "remove-actions-secret", secret: "DEPLOY_TOKEN" },
    { type: "remove-actions-variable", name: "REGION" },
  ]);
  for (
    const target of [
      "production",
      ".github/workflows/build.yml",
      "branch-protection",
      "maintainers",
      "DEPLOY_TOKEN",
      "REGION",
    ]
  ) {
    assertStringIncludes(rendered, JSON.stringify(target));
  }
  assertStringIncludes(rendered, '"id":42');
  assertNotEquals(
    render([{ type: "delete-environment", name: "staging" }]),
    render([{ type: "delete-environment", name: "production" }]),
  );
});

Deno.test("plans show changed settings and permission values", () => {
  const rendered = render([
    {
      type: "update-repository-settings",
      settings: { hasIssues: false, visibility: "private" },
    },
    { type: "update-actions-settings", settings: { enabled: false } },
    { type: "update-actions-oidc", settings: { immutableSubject: true } },
    {
      type: "set-team-permission",
      permission: {
        team: "platform",
        permission: { kind: "built-in", name: "maintain" },
      },
    },
    { type: "set-custom-property", name: "tier", value: "critical" },
  ]);
  for (
    const detail of [
      '"hasIssues":false',
      '"visibility":"private"',
      '"enabled":false',
      '"immutableSubject":true',
      '"team":"platform"',
      '"permission":"maintain"',
      '"name":"tier"',
      '"value":"critical"',
    ]
  ) {
    assertStringIncludes(rendered, detail);
  }
});

Deno.test("ruleset plans show identities and changed rules", () => {
  const rendered = render([
    {
      type: "create-ruleset",
      ruleset: {
        name: "push-policy",
        target: "push",
        enforcement: "active",
        bypassActors: [],
        rules: [],
      },
    },
    {
      type: "update-ruleset",
      id: 42,
      changes: { name: "branch-policy", enforcement: "disabled" },
    },
  ]);
  assertStringIncludes(rendered, '"name":"push-policy"');
  assertStringIncludes(rendered, '"rules":[]');
  assertStringIncludes(rendered, '"id":42');
  assertStringIncludes(rendered, '"enforcement":"disabled"');
});

Deno.test("environment plans identify owned members and collection mode without values", () => {
  const rendered = render([
    {
      type: "create-environment",
      environment: {
        name: "staging",
        variables: [{ name: "REGION", value: "environment-private-value" }],
        secrets: [{ name: "DEPLOY_TOKEN", source: "EXTERNAL_TOKEN" }],
      },
    },
    {
      type: "update-environment",
      collections: "strict",
      environment: { name: "production", variables: [], secrets: [] },
    },
  ]);
  for (
    const detail of [
      '"name":"staging"',
      '"name":"REGION"',
      '"DEPLOY_TOKEN"',
      '"name":"production"',
      '"collections":"strict"',
      '"variables":[]',
      '"secrets":[]',
    ]
  ) {
    assertStringIncludes(rendered, detail);
  }
  assertEquals(rendered.includes("environment-private-value"), false);
});

Deno.test("repository value plans show names without runtime values", () => {
  const rendered = render([
    {
      type: "set-actions-secret",
      secret: { name: "TOKEN", source: "SOURCE_TOKEN" },
    },
    {
      type: "set-actions-variable",
      variable: { name: "REGION", value: "repository-private-value" },
    },
  ]);
  assertStringIncludes(rendered, '"name":"TOKEN"');
  assertStringIncludes(rendered, '"name":"REGION"');
  assertStringIncludes(rendered, "[redacted]");
  assertEquals(rendered.includes("repository-private-value"), false);
});

Deno.test("file plans identify paths and modes without file contents", () => {
  const rendered = render([
    {
      type: "create-file",
      file: {
        path: "README.md",
        ensure: "exists",
        content: "file-private-content",
      },
    },
    {
      type: "update-file",
      sha: "sha",
      file: {
        path: "config.yml",
        ensure: "exact",
        content: "file-private-content",
      },
    },
  ]);
  assertStringIncludes(rendered, '"path":"README.md","ensure":"exists"');
  assertStringIncludes(rendered, '"path":"config.yml","ensure":"exact"');
  assertEquals(rendered.includes("file-private-content"), false);
});

function render(operations: readonly Operation[]): string {
  return renderReport({
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(0),
    repositories: [
      reportPlannedRepository("code", { repository: "sample", operations }),
    ],
  });
}
