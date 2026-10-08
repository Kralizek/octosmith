import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildApplyEvaluations,
  buildPlan,
  type CurrentState,
  type DesiredState,
  type Operation,
  renderReport,
  reportPlannedRepository,
} from "@octosmith/octosmith";
import { currentRepositorySettings, currentState } from "./plan/fixtures.ts";

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

  const evaluations = buildApplyEvaluations(
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

Deno.test("reports transitions and resource operations without exposing values", () => {
  const initialSettings = currentRepositorySettings();
  const current: CurrentState = currentState({
    settings: {
      ...initialSettings,
      merge: {
        ...initialSettings.merge,
        squashMergeCommitMessage: "pull-request-body",
      },
    },
    actions: {
      oidc: {
        subjectClaimTemplate: { source: "default" },
        immutableSubject: false,
      },
      variables: [
        { name: "COPILOT_AGENT_FIREWALL_ENABLED", value: "private-old" },
        { name: "LEGACY_VARIABLE", value: "private-remove" },
      ],
    },
    teams: [{
      team: "developers",
      permission: { kind: "built-in", name: "push" },
    }, {
      team: "legacy-maintainers",
      permission: { kind: "built-in", name: "maintain" },
    }],
    files: [
      {
        path: ".github/workflows/update.yml",
        content: "private-old",
        sha: "a",
      },
      {
        path: ".github/workflows/obsolete.yml",
        content: "private-old",
        sha: "b",
      },
    ],
  });
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    collections: "strict",
    settings: {
      merge: { squashMergeCommitMessage: "blank" },
      securityAndAnalysis: { codeSecurity: "enabled" },
    },
    actions: {
      oidc: { immutableSubject: true },
      variables: [
        { name: "COPILOT_AGENT_FIREWALL_ENABLED", value: "private-new" },
        { name: "NEW_VARIABLE", value: "private-create" },
      ],
    },
    teams: [
      {
        team: "admins",
        permission: { kind: "built-in", name: "admin" },
      },
      {
        team: "developers",
        permission: { kind: "built-in", name: "maintain" },
      },
    ],
    files: [
      {
        path: ".github/workflows/update.yml",
        ensure: "exact",
        content: "private-update",
      },
      {
        path: ".github/workflows/new.yml",
        ensure: "exact",
        content: "private-create",
      },
      { path: ".github/workflows/obsolete.yml", ensure: "absent" },
    ],
  };
  const plan = buildPlan(current, desired);
  const explicitPlan = buildPlan(current, {
    ...desired,
    collections: "explicit",
  });
  const operations: readonly Operation[] = plan.operations;
  const evaluations = buildApplyEvaluations(desired, operations, current);
  const report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      reportPlannedRepository("code", plan, evaluations),
    ],
  };
  const rendered = renderReport(report);
  const serialized = JSON.stringify(report);

  assertStringIncludes(
    rendered,
    "merge.squashMergeCommitMessage: pull-request-body → blank",
  );
  assertStringIncludes(
    rendered,
    "securityAndAnalysis.codeSecurity: unset → enabled",
  );
  assertStringIncludes(rendered, "immutableSubject: false → true");
  assertEquals(rendered.includes("merge.mergeCommitMessage"), false);
  assertStringIncludes(rendered, "Team admins — grant admin");
  assertStringIncludes(rendered, "Team developers — push → maintain");
  assertStringIncludes(rendered, "Team legacy-maintainers — remove");
  assertStringIncludes(
    rendered,
    "Actions variable COPILOT_AGENT_FIREWALL_ENABLED — update",
  );
  assertStringIncludes(rendered, "Actions variable NEW_VARIABLE — create");
  assertStringIncludes(rendered, "Actions variable LEGACY_VARIABLE — remove");
  assertStringIncludes(
    rendered,
    "File .github/workflows/update.yml — update",
  );
  assertStringIncludes(rendered, "File .github/workflows/new.yml — create");
  assertStringIncludes(
    rendered,
    "File .github/workflows/obsolete.yml — remove",
  );
  for (
    const privateValue of [
      "private-old",
      "private-new",
      "private-create",
      "private-remove",
      "private-update",
    ]
  ) {
    assertEquals(serialized.includes(privateValue), false);
  }
  assertEquals(
    explicitPlan.operations.some((operation) =>
      operation.type === "remove-actions-variable" ||
      operation.type === "remove-team-permission"
    ),
    false,
  );
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
  const evaluations = buildApplyEvaluations(
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
