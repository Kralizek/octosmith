import { assertEquals } from "@std/assert";
import { toRepositoryEvent } from "../packages/cli/events.ts";

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
