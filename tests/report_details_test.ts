import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildReconciliationEvaluations,
  type DesiredState,
  renderReport,
  reportPlannedRepository,
} from "@octosmith/core";

Deno.test("evaluation details are safe and resource-oriented", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    settings: { hasIssues: false, visibility: "private" },
    actions: {
      variables: [{ name: "REGION", value: "repository-private-value" }],
      secrets: [{ name: "TOKEN", source: "SOURCE_TOKEN" }],
    },
    files: [{
      path: "config.txt",
      ensure: "exact",
      content: "file-private-content",
    }],
  };
  const operations = [
    {
      type: "update-repository-settings" as const,
      settings: { hasIssues: false, visibility: "private" as const },
    },
    {
      type: "set-actions-variable" as const,
      variable: { name: "REGION", value: "repository-private-value" },
    },
    {
      type: "set-actions-secret" as const,
      secret: { name: "TOKEN", source: "SOURCE_TOKEN" },
    },
    {
      type: "create-file" as const,
      file: {
        path: "config.txt",
        ensure: "exact" as const,
        content: "file-private-content",
      },
    },
  ];

  const evaluations = buildReconciliationEvaluations(
    desired,
    operations,
  );
  const report = reportPlannedRepository(
    "code",
    { repository: "sample", operations },
    evaluations,
  );
  const serialized = JSON.stringify(report);

  assertEquals(serialized.includes("repository-private-value"), false);
  assertEquals(serialized.includes("SOURCE_TOKEN"), false);
  assertEquals(serialized.includes("file-private-content"), false);
  assertStringIncludes(serialized, "REGION");
  assertStringIncludes(serialized, "TOKEN");
  assertStringIncludes(serialized, "config.txt");
});

Deno.test("text output is one human-readable line per changed item", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    actions: {
      variables: [{ name: "REGION", value: "north" }],
      secrets: [{ name: "TOKEN", source: "TOKEN" }],
    },
    teams: [{
      team: "platform",
      permission: { kind: "built-in", name: "maintain" },
    }],
  };
  const plan = {
    repository: "sample",
    operations: [
      {
        type: "set-actions-variable" as const,
        variable: { name: "REGION", value: "north" },
      },
      {
        type: "set-actions-secret" as const,
        secret: { name: "TOKEN", source: "TOKEN" },
      },
      {
        type: "set-team-permission" as const,
        permission: {
          team: "platform",
          permission: { kind: "built-in" as const, name: "maintain" as const },
        },
      },
    ],
  };
  const evaluations = buildReconciliationEvaluations(
    desired,
    plan.operations,
  );
  const rendered = renderReport({
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [reportPlannedRepository("code", plan, evaluations)],
  });

  assertStringIncludes(rendered, "→ Actions variable REGION — update");
  assertStringIncludes(rendered, "→ Actions secret TOKEN — set");
  assertStringIncludes(rendered, "→ Team platform — permission: maintain");
  assertEquals(rendered.includes("{"), false);
  assertEquals(rendered.includes('"'), false);
});
