import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/octosmith/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("Actions secrets are always set because values are opaque", () => {
  assertEquals(
    buildPlan(currentState({ actions: { secrets: ["TOKEN"] } }), {
      repository: "sample",
      template: "code",
      actions: { secrets: [{ name: "TOKEN", source: "TOKEN" }] },
    }),
    {
      repository: "sample",
      operations: [{
        type: "set-actions-secret",
        secret: { name: "TOKEN", source: "TOKEN" },
      }],
    },
  );
});

Deno.test("Actions variables only set when missing or changed", () => {
  assertEquals(
    buildPlan(
      currentState({
        actions: {
          variables: [
            { name: "SAME", value: "1" },
            { name: "CHANGE", value: "old" },
          ],
        },
      }),
      {
        repository: "sample",
        template: "code",
        actions: {
          variables: [
            { name: "SAME", value: "1" },
            { name: "CHANGE", value: "new" },
            { name: "ADD", value: "x" },
          ],
        },
      },
    ),
    {
      repository: "sample",
      operations: [
        {
          type: "set-actions-variable",
          variable: { name: "CHANGE", value: "new" },
        },
        {
          type: "set-actions-variable",
          variable: { name: "ADD", value: "x" },
        },
      ],
    },
  );
});

Deno.test("strict Actions values remove undeclared names", () => {
  const current = currentState({
    actions: {
      secrets: ["KEEP", "REMOVE"],
      variables: [
        { name: "KEEP", value: "same" },
        { name: "REMOVE", value: "old" },
      ],
    },
  });
  const desired = {
    repository: "sample",
    template: "code",
    actions: {
      secrets: [{ name: "KEEP", source: "KEEP" }],
      variables: [{ name: "KEEP", value: "same" }],
    },
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [{
      type: "set-actions-secret",
      secret: { name: "KEEP", source: "KEEP" },
    }],
  });
  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "remove-actions-secret", secret: "REMOVE" },
      { type: "set-actions-secret", secret: { name: "KEEP", source: "KEEP" } },
      { type: "remove-actions-variable", name: "REMOVE" },
    ],
  });
});

Deno.test("Dependabot secrets are independent from Actions secrets", () => {
  const current = currentState({
    actions: { secrets: ["SHARED"] },
    dependabot: { secrets: ["SHARED", "REMOVE"] },
  });
  const desired = {
    repository: "sample",
    template: "code",
    actions: { secrets: [{ name: "SHARED", source: "ACTIONS_SHARED" }] },
    dependabot: {
      secrets: [{ name: "SHARED", source: "DEPENDABOT_SHARED" }],
    },
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [
      {
        type: "set-actions-secret",
        secret: { name: "SHARED", source: "ACTIONS_SHARED" },
      },
      {
        type: "set-dependabot-secret",
        secret: { name: "SHARED", source: "DEPENDABOT_SHARED" },
      },
    ],
  });

  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [
      {
        type: "set-actions-secret",
        secret: { name: "SHARED", source: "ACTIONS_SHARED" },
      },
      { type: "remove-dependabot-secret", secret: "REMOVE" },
      {
        type: "set-dependabot-secret",
        secret: { name: "SHARED", source: "DEPENDABOT_SHARED" },
      },
    ],
  });
});

Deno.test("Actions and Dependabot values reject duplicate desired names", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        actions: {
          secrets: [
            { name: "A", source: "FIRST" },
            { name: "A", source: "SECOND" },
          ],
        },
      }),
    Error,
    "Duplicate Actions secret: A",
  );
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        actions: {
          variables: [
            { name: "A", value: "1" },
            { name: "A", value: "2" },
          ],
        },
      }),
    Error,
    "Duplicate Actions variable: A",
  );
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        dependabot: {
          secrets: [
            { name: "A", source: "FIRST" },
            { name: "A", source: "SECOND" },
          ],
        },
      }),
    Error,
    "Duplicate Dependabot secret: A",
  );
});
