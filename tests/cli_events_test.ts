import { assertEquals } from "@std/assert";
import {
  toPullRequestEvent,
  toRepositoryEvent,
} from "../packages/cli/events.ts";
import type { PullRequestResult } from "@octosmith/octosmith";

for (const action of ["opened", "updated", "closed"] as const) {
  Deno.test("PR " + action + " uses the canonical Hooksmith envelope", () => {
    const result: PullRequestResult = {
      repository: "sample",
      number: 42,
      url: "https://github.com/acme/sample/pull/42",
      ...(action === "closed"
        ? { action, reason: "no_differences" }
        : { action }),
    };
    assertEquals(toPullRequestEvent("acme", result, new Date(0)), {
      type: "pull_request." + action,
      timestamp: "1970-01-01T00:00:00.000Z",
      source: { kind: "github.organization", id: "acme" },
      subject: { kind: "github.pull_request", id: "sample#42" },
      metadata: { producer: "octosmith" },
      data: result,
    });
  });
}

Deno.test("repository plan report maps to Hooksmith event document", () => {
  const event = toRepositoryEvent(
    "acme",
    "plan",
    {
      repository: "api-service",
      template: "code",
      status: "planned",
      items: [{
        type: "actions-variable",
        status: "planned",
        details: {
          name: "REGION",
          action: "update",
        },
      }],
    },
    new Date("2026-09-20T11:00:00.000Z"),
  );

  assertEquals(event, {
    type: "resource.planned",
    timestamp: "2026-09-20T11:00:00.000Z",
    source: {
      kind: "github.organization",
      id: "acme",
    },
    subject: {
      kind: "github.repository",
      id: "api-service",
    },
    metadata: {
      producer: "octosmith",
      status: "planned",
      template: "code",
    },
    data: {
      items: [{
        type: "actions-variable",
        status: "planned",
        details: {
          name: "REGION",
          action: "update",
        },
      }],
    },
  });
});

Deno.test("failed repository report retains error in Hooksmith event data", () => {
  const event = toRepositoryEvent(
    "acme",
    "apply",
    {
      repository: "api-service",
      status: "failed",
      items: [],
      error: "boom",
    },
    new Date("2026-09-20T11:00:00.000Z"),
  );

  assertEquals(event.type, "resource.applied");
  assertEquals(event.metadata, {
    producer: "octosmith",
    status: "failed",
  });
  assertEquals(event.data, {
    items: [],
    error: "boom",
  });
});
