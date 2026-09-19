import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan, type DesiredState } from "../../packages/core/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("buildPlan rejects mismatched repositories", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "other",
        template: "code",
      }),
    Error,
    "Cannot build a plan for different repositories",
  );
});

Deno.test("buildPlan returns an empty plan when no desired resources are owned", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
    }),
    {
      repository: "sample",
      operations: [],
    },
  );
});

Deno.test("buildPlan reconciles a mixed desired state", () => {
  const current = currentState({
    customProperties: { tier: "normal" },
    teams: [{
      team: "platform",
      permission: { kind: "built-in", name: "pull" },
    }],
    actions: { variables: [{ name: "REGION", value: "west" }] },
    files: [{ path: "README.md", content: "old", sha: "sha" }],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    settings: { hasIssues: false },
    customProperties: { tier: "critical" },
    teams: [{
      team: "platform",
      permission: { kind: "built-in", name: "maintain" },
    }],
    actions: { variables: [{ name: "REGION", value: "north" }] },
    files: [{ path: "README.md", ensure: "exact", content: "new" }],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [
      {
        type: "update-repository-settings",
        settings: { hasIssues: false },
      },
      {
        type: "set-custom-property",
        name: "tier",
        value: "critical",
      },
      {
        type: "set-actions-variable",
        variable: { name: "REGION", value: "north" },
      },
      {
        type: "set-team-permission",
        permission: {
          team: "platform",
          permission: { kind: "built-in", name: "maintain" },
        },
      },
      {
        type: "update-file",
        sha: "sha",
        file: { path: "README.md", ensure: "exact", content: "new" },
      },
    ],
  });
});
