import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ApplyEvaluation,
  type Operation,
  renderReport,
  type Report,
  reportAppliedRepository,
  reportFailedRepository,
  reportPlannedRepository,
} from "@octosmith/octosmith";

const operation: Operation = {
  type: "set-custom-property",
  name: "tier",
  value: "critical",
};

const evaluation: ApplyEvaluation = {
  type: "custom-property",
  details: { name: "tier", value: "critical", action: "set" },
  operation,
};

const unchangedEvaluation: ApplyEvaluation = {
  type: "team-permission",
  details: { team: "maintainers", permission: "maintain" },
};

Deno.test("planned reports include changed and unchanged evaluations", () => {
  assertEquals(
    reportPlannedRepository(
      "code",
      { repository: "sample", operations: [operation] },
      [unchangedEvaluation, evaluation],
    ),
    {
      repository: "sample",
      template: "code",
      status: "planned",
      items: [
        {
          type: "team-permission",
          status: "unchanged",
          details: { team: "maintainers", permission: "maintain" },
        },
        {
          type: "custom-property",
          status: "planned",
          details: { name: "tier", value: "critical", action: "set" },
        },
      ],
    },
  );
});

Deno.test("applied reports map outcomes onto apply items", () => {
  const report = reportAppliedRepository(
    "code",
    "sample",
    [unchangedEvaluation, evaluation],
    [{ operation, status: "failed", error: "boom" }],
  );

  assertEquals(report.status, "failed");
  assertEquals(report.items, [
    {
      type: "team-permission",
      status: "unchanged",
      details: { team: "maintainers", permission: "maintain" },
    },
    {
      type: "custom-property",
      status: "failed",
      details: { name: "tier", value: "critical", action: "set" },
      error: "boom",
    },
  ]);
});

Deno.test("applied reports reject skipped operations without a failure", () => {
  let message: string | undefined;

  try {
    reportAppliedRepository(
      "code",
      "sample",
      [evaluation],
      [{ operation, status: "skipped" }],
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(message, "Skipped operations require a failed operation");
});

Deno.test("failed reports can represent errors before template resolution", () => {
  assertEquals(
    reportFailedRepository("broken", new Error("no template")),
    {
      repository: "broken",
      status: "failed",
      items: [],
      error: "no template",
    },
  );
});

Deno.test("text renderer uses concise status icons and hides unchanged items", () => {
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      reportPlannedRepository(
        "code",
        { repository: "api", operations: [operation] },
        [unchangedEvaluation, evaluation],
      ),
      reportFailedRepository("broken", "read failed"),
    ],
  };

  const rendered = renderReport(report);

  assertStringIncludes(rendered, "→ api [code] — planned");
  assertStringIncludes(rendered, "→ Custom property tier — set: critical");
  assertEquals(rendered.includes("Team maintainers"), false);
  assertStringIncludes(rendered, "✗ broken — failed");
  assertStringIncludes(rendered, "✗ read failed");
});

Deno.test("text renderer prefers template display names", () => {
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      reportPlannedRepository(
        "repository:team-a/backend",
        { repository: "api", operations: [operation] },
        [evaluation],
        "Backend services",
      ),
    ],
  };

  const rendered = renderReport(report);

  assertStringIncludes(rendered, "→ api [Backend services] — planned");
  assertEquals(rendered.includes("repository:team-a/backend"), false);
});

Deno.test("text renderer groups shared runtime failures and preserves unique errors", () => {
  const slackDiagnostic = (repository: string) => ({
    severity: "error" as const,
    code: "missing_secret" as const,
    name: "SLACK_BOT_OPERATION_TOKEN",
    template: "repository:services",
    path: "repository.actions.secrets[0]",
    resource: { type: "repository" as const, name: "acme/" + repository },
  });
  const copilotDiagnostic = (repository: string) => ({
    ...slackDiagnostic(repository),
    name: "COPILOT_REVIEW_TOKEN",
    path: "repository.actions.secrets[1]",
  });
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      {
        repository: "repo-a",
        template: "repository:services",
        status: "failed",
        items: [],
        error:
          'Required secret "SLACK_BOT_OPERATION_TOKEN" is not available in the current context.\n\nReferenced by:',
        diagnostics: [slackDiagnostic("repo-a"), copilotDiagnostic("repo-a")],
      },
      {
        repository: "repo-b",
        template: "repository:services",
        status: "failed",
        items: [],
        error:
          'Required secret "SLACK_BOT_OPERATION_TOKEN" is not available in the current context.',
        diagnostics: [slackDiagnostic("repo-b"), copilotDiagnostic("repo-b")],
      },
      {
        repository: "repo-c",
        template: "repository:infrastructure",
        status: "failed",
        items: [],
        error: "resource-specific read failure",
        diagnostics: [slackDiagnostic("repo-c")],
      },
    ],
  };
  const rendered = renderReport(report, { verbose: true });
  const serialized = JSON.stringify(report);

  assertStringIncludes(rendered, "✗ repo-a [repository:services] — failed");
  assertStringIncludes(rendered, "✗ repo-b [repository:services] — failed");
  assertStringIncludes(
    rendered,
    "✗ repo-c [repository:infrastructure] — failed",
  );
  assertEquals(
    rendered.split('Required secret "SLACK_BOT_OPERATION_TOKEN"').length - 1,
    1,
  );
  assertStringIncludes(rendered, "Affected resources (3):");
  assertStringIncludes(rendered, "Affected resources (2):");
  assertStringIncludes(rendered, "    repo-a");
  assertStringIncludes(rendered, "    repo-b");
  assertStringIncludes(rendered, "    repo-c");
  assertStringIncludes(rendered, "✗ resource-specific read failure");
  assertStringIncludes(
    rendered,
    "Repositories: 0 planned, 0 unchanged, 0 applied, 0 partially-applied, 3 failed",
  );
  assertEquals(serialized.includes("Failures:"), false);
  assertEquals(
    report.repositories.map((repository) => repository.diagnostics?.length),
    [2, 2, 1],
  );
});

Deno.test("text renderer groups skipped runtime warnings without changing severity", () => {
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: ["repo-a", "repo-b"].map((name) => ({
      repository: name,
      status: "planned" as const,
      items: [],
      diagnostics: [{
        severity: "warning" as const,
        code: "skipped_secret" as const,
        name: "MISSING_TOKEN",
        template: "repository:services",
        path: "repository.actions.secrets[0]",
        resource: { type: "repository" as const, name: "acme/" + name },
      }],
    })),
  };
  const rendered = renderReport(report);

  assertStringIncludes(rendered, "Warnings:");
  assertStringIncludes(rendered, "MISSING_TOKEN (secret) — 2 repositories");
  assertStringIncludes(rendered, "2 bindings excluded from reconciliation.");
  assertEquals(rendered.includes("Failures:"), false);
  assertEquals(rendered.includes("Affected resources:"), false);

  const verbose = renderReport(report, { verbose: true });
  assertStringIncludes(verbose, "Affected resources:");
  assertStringIncludes(verbose, "        repo-a");
});

Deno.test("summary separates skipped runtime bindings from skipped operations", () => {
  const skippedDiagnostic = (repository: string) => ({
    severity: "warning" as const,
    code: "skipped_variable" as const,
    name: "MISSING_VARIABLE",
    template: "repository:services",
    path: "repository.actions.variables[0]",
    resource: { type: "repository" as const, name: "acme/" + repository },
  });
  const skippedOperation: Operation = {
    type: "set-custom-property",
    name: "skipped",
    value: "value",
  };
  const failedOperation: Operation = {
    type: "set-custom-property",
    name: "failed",
    value: "value",
  };
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      reportAppliedRepository(
        "code",
        "repo-a",
        [
          evaluation,
          {
            type: "custom-property",
            details: { name: "skipped", action: "set", value: "value" },
            operation: skippedOperation,
          },
          {
            type: "custom-property",
            details: { name: "failed", action: "set", value: "value" },
            operation: failedOperation,
          },
        ],
        [
          { operation, status: "applied" },
          { operation: skippedOperation, status: "skipped" },
          { operation: failedOperation, status: "failed", error: "failed" },
        ],
        undefined,
        [skippedDiagnostic("repo-a"), skippedDiagnostic("repo-a")],
      ),
      ...["repo-b", "repo-c"].map((repository) => ({
        repository,
        status: "planned" as const,
        items: [],
        diagnostics: [
          skippedDiagnostic(repository),
          skippedDiagnostic(repository),
        ],
      })),
    ],
  };
  const rendered = renderReport(report);

  assertStringIncludes(
    rendered,
    "MISSING_VARIABLE (variable) — 3 repositories",
  );
  assertStringIncludes(
    rendered,
    "Operations:   0 planned, 1 applied, 1 failed, 1 skipped",
  );
  assertStringIncludes(rendered, "Exclusions:   3 skipped runtime bindings");
  assertStringIncludes(rendered, "3 bindings excluded from reconciliation.");
});

Deno.test("generic report values distinguish null from an empty string", () => {
  const rendered = renderReport({
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [{
      repository: "sample",
      status: "planned",
      items: [
        {
          type: "custom-property",
          status: "planned",
          details: { name: "NULL_VALUE", action: "set", value: null },
        },
        {
          type: "custom-property",
          status: "planned",
          details: { name: "EMPTY_VALUE", action: "set", value: "" },
        },
      ],
    }],
  });

  assertStringIncludes(rendered, "Custom property NULL_VALUE — set: null");
  assertStringIncludes(rendered, "Custom property EMPTY_VALUE — set: \n");
});

Deno.test("verbose text includes unchanged apply items", () => {
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      reportPlannedRepository(
        "code",
        { repository: "api", operations: [operation] },
        [unchangedEvaluation, evaluation],
      ),
    ],
  };

  const rendered = renderReport(report, { verbose: true });

  assertStringIncludes(
    rendered,
    "- Team maintainers — permission: maintain",
  );
});

for (const unmatched of [undefined, 0, 2]) {
  Deno.test(`summary distinguishes absent inspection from unmatched count ${unmatched}`, () => {
    const report: Report = {
      organization: "acme",
      startedAt: new Date(0),
      completedAt: new Date(1),
      repositories: [],
      mode: "plan",
      unmatchedPolicy: "ignore",
      ...(unmatched !== undefined && {
        inspection: {
          resources: Array.from({ length: unmatched }, (_, index) => ({
            type: "repository",
            name: "acme/unmatched-" + index,
            template: null,
            status: "unmatched" as const,
          })),
          summary: { matched: 0, unmatched },
        },
      }),
    };

    const repositorySummary = renderReport(report).split("\n").find((line) =>
      line.startsWith("  Repositories:")
    );
    assertEquals(
      repositorySummary,
      "  Repositories: 0 planned, 0 unchanged, 0 applied, 0 partially-applied, 0 failed" +
        (unmatched === undefined ? "" : ", " + unmatched + " unmatched"),
    );
  });
}

Deno.test("unmatched resources are grouped by type with redundant organization omitted", () => {
  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [],
    mode: "plan",
    unmatchedPolicy: "ignore",
    inspection: {
      resources: [
        {
          type: "repository",
          name: "acme/repo-a",
          template: null,
          status: "unmatched",
        },
        {
          type: "repository",
          name: "acme/repo-b",
          template: null,
          status: "unmatched",
        },
        {
          type: "environment",
          name: "production",
          template: null,
          status: "unmatched",
        },
      ],
      summary: { matched: 0, unmatched: 3 },
    },
  };
  const rendered = renderReport(report);

  assertStringIncludes(rendered, "Unmatched repositories (2):");
  assertStringIncludes(rendered, "  Policy: ignore");
  assertStringIncludes(
    rendered,
    "  These repositories are excluded from reconciliation.",
  );
  assertStringIncludes(rendered, "  repo-a\n  repo-b");
  assertStringIncludes(rendered, "Unmatched environments (1):");
  assertStringIncludes(
    rendered,
    "Repositories: 0 planned, 0 unchanged, 0 applied, 0 partially-applied, 0 failed, 2 unmatched",
  );
  assertEquals(rendered.includes("acme/repo-a"), false);
  assertEquals(rendered.includes("acme/repo-b"), false);
});

Deno.test("summary counts every repository outcome exactly", () => {
  const applied = reportAppliedRepository(
    "code",
    "applied",
    [evaluation],
    [{ operation, status: "applied" }],
  );
  const failed = reportAppliedRepository(
    "code",
    "failed",
    [evaluation],
    [{ operation, status: "failed", error: "boom" }],
  );

  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    repositories: [
      reportPlannedRepository("code", {
        repository: "unchanged",
        operations: [],
      }, [unchangedEvaluation]),
      reportPlannedRepository("code", {
        repository: "planned",
        operations: [operation],
      }, [evaluation]),
      applied,
      failed,
    ],
  };

  assertStringIncludes(
    renderReport(report),
    "Repositories: 1 planned, 1 unchanged, 1 applied, 0 partially-applied, 1 failed",
  );
});

Deno.test("reports unmatched error policy and actual pull requests once", () => {
  const pullRequest = {
    repository: "sample",
    number: 42,
    url: "https://github.com/acme/sample/pull/42",
  };
  const failedOperation: Operation = {
    type: "set-custom-property",
    name: "component",
    value: null,
  };
  const applied = reportAppliedRepository(
    "code",
    "sample",
    [
      evaluation,
      {
        type: "custom-property",
        details: { name: "component", action: "remove" },
        operation: failedOperation,
      },
    ],
    [
      { operation, status: "applied" },
      {
        operation: failedOperation,
        status: "failed",
        error: "later operation failed",
      },
    ],
    undefined,
    undefined,
    [pullRequest, pullRequest],
  );
  assertEquals(applied.status, "partially-applied");
  assertEquals(applied.pullRequestsOpened, [pullRequest]);

  const report: Report = {
    organization: "acme",
    startedAt: new Date(0),
    completedAt: new Date(1),
    mode: "apply",
    unmatchedPolicy: "error",
    repositories: [{
      repository: "sample",
      status: "partially-applied",
      items: [],
      pullRequestsOpened: [pullRequest, pullRequest],
    }],
    pullRequestsOpened: [pullRequest],
    inspection: {
      resources: [{
        type: "repository",
        name: "acme/legacy",
        template: null,
        status: "unmatched",
      }],
      summary: { matched: 1, unmatched: 1 },
    },
  };
  const rendered = renderReport(report);

  assertStringIncludes(rendered, "Policy: error");
  assertStringIncludes(rendered, "Apply cannot complete successfully.");
  assertStringIncludes(rendered, "Pull requests opened (1):");
  assertStringIncludes(
    rendered,
    "sample — acme/sample#42 https://github.com/acme/sample/pull/42",
  );
  assertEquals(
    rendered.split("https://github.com/acme/sample/pull/42").length - 1,
    1,
  );
  assertEquals(
    (JSON.parse(JSON.stringify(report)) as Report).pullRequestsOpened,
    [pullRequest],
  );
});

Deno.test("repository-level failures retain planned operations as skipped", () => {
  const failed = reportFailedRepository(
    "sample",
    new Error("recheck failed"),
    "code",
    undefined,
    [],
    [unchangedEvaluation, evaluation],
  );
  assertEquals(failed.items.map((item) => item.status), [
    "unchanged",
    "skipped",
  ]);
  const output = renderReport({
    organization: "example-org",
    startedAt: new Date(0),
    completedAt: new Date(0),
    repositories: [failed],
  });
  assertStringIncludes(output, "1 skipped");
  assertStringIncludes(output, "0 applied");
});
