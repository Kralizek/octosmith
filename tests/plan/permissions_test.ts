import { assertEquals } from "@std/assert";
import {
  aggregateGitHubPermissionRequirements,
  getGitHubPermissionDescriptor,
  type GitHubPermissionRequirement,
  requiredPermissionsForOperation,
  requiredPermissionsForOperationType,
  requiredPermissionsForPlan,
} from "../../packages/octosmith/mod.ts";

Deno.test("permission descriptors expose API and GitHub display names", () => {
  assertEquals(
    getGitHubPermissionDescriptor("repository", "repository_custom_properties"),
    {
      apiName: "repository_custom_properties",
      displayName: "Custom properties",
    },
  );
  assertEquals(getGitHubPermissionDescriptor("repository", "pull_requests"), {
    apiName: "pull_requests",
    displayName: "Pull requests",
  });
  assertEquals(
    getGitHubPermissionDescriptor({
      scope: "organization",
      permission: "members",
      access: "read",
    }),
    {
      apiName: "members",
      displayName: "Members",
    },
  );
});

Deno.test("repository operation permissions are available by operation and type", () => {
  assertEquals(
    requiredPermissionsForOperation({
      type: "set-actions-variable",
      variable: { name: "REGION", value: "eu-north-1" },
    }),
    [{
      scope: "repository",
      permission: "actions_variables",
      access: "write",
    }],
  );

  assertEquals(requiredPermissionsForOperationType("update-actions-oidc"), [{
    scope: "repository",
    permission: "actions",
    access: "write",
  }]);
});

Deno.test("team permission operations include repository and organization requirements", () => {
  assertEquals(requiredPermissionsForOperationType("set-team-permission"), [
    {
      scope: "repository",
      permission: "administration",
      access: "write",
    },
    {
      scope: "organization",
      permission: "members",
      access: "read",
    },
    {
      scope: "repository",
      permission: "metadata",
      access: "read",
    },
  ]);
});

Deno.test("file operations use pull-request delivery permissions by default", () => {
  assertEquals(requiredPermissionsForOperationType("update-file"), [
    {
      scope: "repository",
      permission: "contents",
      access: "write",
    },
    {
      scope: "repository",
      permission: "issues",
      access: "write",
    },
    {
      scope: "repository",
      permission: "pull_requests",
      access: "write",
    },
  ]);
});

Deno.test("file operations include pull-request permissions when requested", () => {
  assertEquals(
    requiredPermissionsForOperationType("update-file", "pull_request"),
    [
      {
        scope: "repository",
        permission: "contents",
        access: "write",
      },
      {
        scope: "repository",
        permission: "issues",
        access: "write",
      },
      {
        scope: "repository",
        permission: "pull_requests",
        access: "write",
      },
    ],
  );
});

Deno.test("file operations can request direct delivery explicitly", () => {
  assertEquals(requiredPermissionsForOperationType("update-file", "direct"), [
    {
      scope: "repository",
      permission: "contents",
      access: "write",
    },
  ]);
});

Deno.test("permission aggregation retains strongest access and deterministic order", () => {
  const requirements: GitHubPermissionRequirement[] = [
    { scope: "repository", permission: "contents", access: "read" },
    { scope: "organization", permission: "members", access: "read" },
    { scope: "repository", permission: "actions_variables", access: "write" },
    { scope: "repository", permission: "contents", access: "write" },
    { scope: "repository", permission: "contents", access: "read" },
  ];

  assertEquals(aggregateGitHubPermissionRequirements(requirements), [
    { scope: "organization", permission: "members", access: "read" },
    { scope: "repository", permission: "actions_variables", access: "write" },
    { scope: "repository", permission: "contents", access: "write" },
  ]);
});

Deno.test("plan permissions aggregate duplicate operation requirements", () => {
  assertEquals(
    requiredPermissionsForPlan({
      repository: "sample",
      operations: [
        {
          type: "set-actions-variable",
          variable: { name: "REGION", value: "eu-north-1" },
        },
        {
          type: "remove-actions-variable",
          name: "OLD_REGION",
        },
        {
          type: "set-actions-secret",
          secret: { name: "TOKEN", source: "TOKEN" },
        },
      ],
    }),
    [
      { scope: "repository", permission: "actions_variables", access: "write" },
      { scope: "repository", permission: "secrets", access: "write" },
    ],
  );
});
