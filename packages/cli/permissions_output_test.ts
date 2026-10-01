import { assertEquals, assertStringIncludes } from "@std/assert";
import type { GitHubPermissionRequirement } from "@octosmith/octosmith";
import {
  parsePermissionOutputFormat,
  renderPermissionsGithubOutput,
} from "./permissions_output.ts";

Deno.test("parsePermissionOutputFormat accepts text, json, and github-output", () => {
  assertEquals(parsePermissionOutputFormat("text"), "text");
  assertEquals(parsePermissionOutputFormat("json"), "json");
  assertEquals(parsePermissionOutputFormat("github-output"), "github-output");
});

Deno.test("parsePermissionOutputFormat rejects unsupported formats", () => {
  let message: string | undefined;
  try {
    parsePermissionOutputFormat("yaml");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(
    message,
    "Unsupported output format: yaml. Expected text, json, or github-output",
  );
});

Deno.test("renderPermissionsGithubOutput renders repository permissions", () => {
  const requirements: readonly GitHubPermissionRequirement[] = [
    { scope: "repository", permission: "administration", access: "write" },
    { scope: "repository", permission: "contents", access: "write" },
  ];

  assertEquals(
    renderPermissionsGithubOutput(requirements),
    "permission-administration=write\npermission-contents=write",
  );
});

Deno.test("renderPermissionsGithubOutput renders organization permissions", () => {
  const requirements: readonly GitHubPermissionRequirement[] = [
    { scope: "organization", permission: "members", access: "read" },
  ];

  assertEquals(
    renderPermissionsGithubOutput(requirements),
    "permission-members=read",
  );
});

Deno.test("renderPermissionsGithubOutput deterministically orders mixed scopes", () => {
  const requirements: readonly GitHubPermissionRequirement[] = [
    { scope: "organization", permission: "members", access: "read" },
    { scope: "repository", permission: "pull_requests", access: "write" },
    { scope: "repository", permission: "administration", access: "write" },
    { scope: "repository", permission: "contents", access: "write" },
    { scope: "repository", permission: "issues", access: "write" },
  ];

  assertEquals(
    renderPermissionsGithubOutput(requirements),
    [
      "permission-administration=write",
      "permission-contents=write",
      "permission-issues=write",
      "permission-members=read",
      "permission-pull-requests=write",
    ].join("\n"),
  );
});

Deno.test("renderPermissionsGithubOutput is order-independent (deterministic sort)", () => {
  const requirements: readonly GitHubPermissionRequirement[] = [
    { scope: "repository", permission: "pull_requests", access: "write" },
    { scope: "organization", permission: "members", access: "read" },
    { scope: "repository", permission: "issues", access: "write" },
  ];
  const reversed = [...requirements].reverse();

  assertEquals(
    renderPermissionsGithubOutput(requirements),
    renderPermissionsGithubOutput(reversed),
  );
});

Deno.test("renderPermissionsGithubOutput renders an empty string when there are no permissions", () => {
  assertEquals(renderPermissionsGithubOutput([]), "");
});

Deno.test("renderPermissionsGithubOutput maps GitHub API names to actions/create-github-app-token input names", () => {
  const requirements: readonly GitHubPermissionRequirement[] = [
    {
      scope: "repository",
      permission: "repository_custom_properties",
      access: "write",
    },
    { scope: "repository", permission: "dependabot_secrets", access: "read" },
    { scope: "repository", permission: "variables", access: "write" },
    { scope: "repository", permission: "workflows", access: "write" },
  ];

  const rendered = renderPermissionsGithubOutput(requirements);
  assertStringIncludes(
    rendered,
    "permission-repository-custom-properties=write",
  );
  assertStringIncludes(rendered, "permission-dependabot-secrets=read");
  assertStringIncludes(rendered, "permission-variables=write");
  assertStringIncludes(rendered, "permission-workflows=write");
});

Deno.test("renderPermissionsGithubOutput deduplicates repeated permissions, keeping the strongest access", () => {
  const requirements: readonly GitHubPermissionRequirement[] = [
    { scope: "repository", permission: "administration", access: "read" },
    { scope: "repository", permission: "administration", access: "write" },
  ];

  assertEquals(
    renderPermissionsGithubOutput(requirements),
    "permission-administration=write",
  );
});
