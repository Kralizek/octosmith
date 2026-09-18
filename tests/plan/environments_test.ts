import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/core/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("environments create and update variables", () => {
  const current = currentState({
    environments: [{
      name: "production",
      secrets: [],
      variables: [{ name: "REGION", value: "west" }],
    }],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      environments: [
        {
          name: "production",
          secrets: [],
          variables: [{ name: "REGION", value: "north" }],
        },
        { name: "staging", secrets: [], variables: [] },
      ],
    }),
    {
      repository: "sample",
      operations: [
        {
          type: "update-environment",
          environment: {
            name: "production",
            secrets: [],
            variables: [{ name: "REGION", value: "north" }],
          },
        },
        {
          type: "create-environment",
          environment: { name: "staging", secrets: [], variables: [] },
        },
      ],
    },
  );
});

Deno.test("environment secrets force update because values are opaque", () => {
  assertEquals(
    buildPlan(
      currentState({
        environments: [{
          name: "production",
          secrets: ["TOKEN"],
          variables: [],
        }],
      }),
      {
        repository: "sample",
        template: "code",
        environments: [{
          name: "production",
          secrets: ["TOKEN"],
          variables: [],
        }],
      },
    ),
    {
      repository: "sample",
      operations: [{
        type: "update-environment",
        environment: {
          name: "production",
          secrets: ["TOKEN"],
          variables: [],
        },
      }],
    },
  );
});

Deno.test("strict environments remove undeclared names while sparse preserves them", () => {
  const current = currentState({
    environments: [
      { name: "keep", secrets: [], variables: [] },
      { name: "remove", secrets: [], variables: [] },
    ],
  });
  const desired = {
    repository: "sample",
    template: "code",
    environments: [{ name: "keep", secrets: [], variables: [] }],
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });
  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [{ type: "delete-environment", name: "remove" }],
  });
});

Deno.test("environments reject duplicate names", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        environments: [
          { name: "production", secrets: [], variables: [] },
          { name: "production", secrets: [], variables: [] },
        ],
      }),
    Error,
    "Duplicate environment: production",
  );
});
