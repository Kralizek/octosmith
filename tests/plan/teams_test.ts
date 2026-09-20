import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/octosmith/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("teams add and update permissions without removing undeclared teams in explicit mode", () => {
  const current = currentState({
    teams: [
      { team: "keep", permission: { kind: "built-in", name: "pull" } },
      { team: "unmanaged", permission: { kind: "custom", name: "release" } },
    ],
  });
  const desired = {
    repository: "sample",
    template: "code",
    teams: [
      { team: "keep", permission: { kind: "built-in", name: "maintain" } },
      { team: "add", permission: { kind: "built-in", name: "push" } },
    ],
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [
      {
        type: "set-team-permission",
        permission: {
          team: "keep",
          permission: { kind: "built-in", name: "maintain" },
        },
      },
      {
        type: "set-team-permission",
        permission: {
          team: "add",
          permission: { kind: "built-in", name: "push" },
        },
      },
    ],
  });

  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "remove-team-permission", team: "unmanaged" },
      {
        type: "set-team-permission",
        permission: {
          team: "keep",
          permission: { kind: "built-in", name: "maintain" },
        },
      },
      {
        type: "set-team-permission",
        permission: {
          team: "add",
          permission: { kind: "built-in", name: "push" },
        },
      },
    ],
  });
});

Deno.test("teams empty collection is non-destructive unless strict", () => {
  const current = currentState({
    teams: [{ team: "a", permission: { kind: "built-in", name: "pull" } }],
  });
  const desired = {
    repository: "sample",
    template: "code",
    teams: [],
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });
  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [{ type: "remove-team-permission", team: "a" }],
  });
});

Deno.test("teams reject duplicate names", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        teams: [
          { team: "a", permission: { kind: "built-in", name: "pull" } },
          { team: "a", permission: { kind: "built-in", name: "push" } },
        ],
      }),
    Error,
    "Duplicate team: a",
  );
});
