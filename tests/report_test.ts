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
