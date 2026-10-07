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
  const rendered = renderReport(report);
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
    "Summary: 0 unchanged, 0 planned, 0 applied, 0 partially-applied, 3 failed",
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
  assertStringIncludes(
    rendered,
    'Skipped secret "MISSING_TOKEN": runtime value unavailable.',
  );
  assertStringIncludes(rendered, "Affected resources (2):");
  assertEquals(rendered.includes("Failures:"), false);
  assertEquals(
    rendered.split('Skipped secret "MISSING_TOKEN"').length - 1,
    1,
  );
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

    assertEquals(
      renderReport(report).split("\n").at(-1),
      "Summary: 0 unchanged, 0 planned, 0 applied, 0 partially-applied, 0 failed" +
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
  assertStringIncludes(rendered, "  repo-a\n  repo-b");
  assertStringIncludes(rendered, "Unmatched environments (1):");
  assertStringIncludes(
    rendered,
    "Summary: 0 unchanged, 0 planned, 0 applied, 0 partially-applied, 0 failed, 3 unmatched",
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
    "Summary: 1 unchanged, 1 planned, 1 applied, 0 partially-applied, 1 failed",
  );
});
