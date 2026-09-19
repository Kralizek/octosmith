import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/core/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("repository secrets are always set because values are opaque", () => {
  assertEquals(
    buildPlan(currentState({ secrets: ["TOKEN"] }), {
      repository: "sample",
      template: "code",
      secrets: ["TOKEN"],
    }),
    {
      repository: "sample",
      operations: [{ type: "set-repository-secret", secret: "TOKEN" }],
    },
  );
});

Deno.test("repository variables only set when missing or changed", () => {
  assertEquals(
    buildPlan(
      currentState({
        variables: [
          { name: "SAME", value: "1" },
          { name: "CHANGE", value: "old" },
        ],
      }),
      {
        repository: "sample",
        template: "code",
        variables: [
          { name: "SAME", value: "1" },
          { name: "CHANGE", value: "new" },
          { name: "ADD", value: "x" },
        ],
      },
    ),
    {
      repository: "sample",
      operations: [
        {
          type: "set-repository-variable",
          variable: { name: "CHANGE", value: "new" },
        },
        {
          type: "set-repository-variable",
          variable: { name: "ADD", value: "x" },
        },
      ],
    },
  );
});

Deno.test("strict repository values remove undeclared names", () => {
  const current = currentState({
    secrets: ["KEEP", "REMOVE"],
    variables: [
      { name: "KEEP", value: "same" },
      { name: "REMOVE", value: "old" },
    ],
  });
  const desired = {
    repository: "sample",
    template: "code",
    secrets: ["KEEP"],
    variables: [{ name: "KEEP", value: "same" }],
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [{ type: "set-repository-secret", secret: "KEEP" }],
  });
  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "remove-repository-secret", secret: "REMOVE" },
      { type: "set-repository-secret", secret: "KEEP" },
      { type: "remove-repository-variable", name: "REMOVE" },
    ],
  });
});

Deno.test("repository values reject duplicate desired names", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        secrets: ["A", "A"],
      }),
    Error,
    "Duplicate repository secret: A",
  );
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        variables: [
          { name: "A", value: "1" },
          { name: "A", value: "2" },
        ],
      }),
    Error,
    "Duplicate repository variable: A",
  );
});
