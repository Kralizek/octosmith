import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderReport,
  type Report,
  reportAppliedRepository,
  reportFailedRepository,
  reportPlannedRepository,
} from "@octosmith/core";

const operation = {
  type: "set-custom-property" as const,
  name: "tier",
  value: "critical",
};

Deno.test("planned reports distinguish unchanged and drift", () => {
  assertEquals(
    reportPlannedRepository("code", {
      repository: "clean",
      operations: [],
    }),
    {
      repository: "clean",
      template: "code",
      status: "unchanged",
      operations: [],
    },
  );

  assertEquals(
    reportPlannedRepository("code", {
      repository: "drifted",
      operations: [operation],
    }),
    {
      repository: "drifted",
      template: "code",
      status: "planned",
      operations: [{ operation, status: "planned" }],
    },
  );
});

Deno.test("applied reports distinguish success and partial failure", () => {
  assertEquals(
    reportAppliedRepository("code", "sample", [
      { operation, status: "applied" },
    ]).status,
    "applied",
  );

  assertEquals(
    reportAppliedRepository("code", "sample", [
      { operation, status: "applied" },
      {
        operation: {
          type: "remove-team-permission",
          team: "legacy",
        },
        status: "failed",
        error: "forbidden",
      },
      {
        operation: {
          type: "delete-environment",
          name: "old",
        },
        status: "skipped",
      },
    ]).status,
    "partially-applied",
  );
});

Deno.test("applied reports reject skipped operations without a failure", () => {
  let message: string | undefined;

  try {
    reportAppliedRepository("code", "sample", [
      { operation, status: "skipped" },
    ]);
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
      operations: [],
      error: "no template",
    },
  );
});

Deno.test("text renderer includes repository, operation and summary status", () => {
  const report: Report = {
    organization: "acme",
    startedAt: new Date("2026-09-18T12:00:00Z"),
    completedAt: new Date("2026-09-18T12:00:01Z"),
    repositories: [
      reportPlannedRepository("code", {
        repository: "api",
        operations: [operation],
      }),
      reportAppliedRepository("code", "partial", [
        { operation, status: "applied" },
        {
          operation: {
            type: "remove-team-permission",
            team: "legacy",
          },
          status: "failed",
          error: "forbidden",
        },
      ]),
      reportFailedRepository("broken", "read failed"),
    ],
  };

  const rendered = renderReport(report);

  assertStringIncludes(rendered, "OctoSmith report for acme");
  assertStringIncludes(rendered, "~ api [code] — planned");
  assertStringIncludes(
    rendered,
    "set-custom-property — planned",
  );
  assertStringIncludes(rendered, "! partial [code] — partially-applied");
  assertStringIncludes(rendered, "! broken — failed");
  assertStringIncludes(rendered, "1 planned");
  assertStringIncludes(rendered, "1 partially-applied");
  assertStringIncludes(rendered, "1 failed");
  assertStringIncludes(
    rendered,
    "Summary: 0 unchanged, 1 planned, 0 applied, 1 partially-applied, 1 failed",
  );
});
