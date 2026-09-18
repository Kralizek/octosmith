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
          collections: "sparse",
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
        collections: "sparse",
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

Deno.test("sparse environment variables preserve undeclared siblings", () => {
  const current = currentState({
    environments: [{
      name: "production",
      secrets: [],
      variables: [
        { name: "REGION", value: "north" },
        { name: "EXTRA", value: "preserve" },
      ],
    }],
  });
  const desired = {
    repository: "sample",
    template: "code",
    environments: [{
      name: "production",
      variables: [{ name: "REGION", value: "north" }],
    }],
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });
  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [{
      type: "update-environment",
      collections: "strict",
      environment: desired.environments[0],
    }],
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

Deno.test("omitted environment secrets and variables remain unmanaged", () => {
  assertEquals(
    buildPlan(
      currentState({
        environments: [{
          name: "production",
          secrets: ["TOKEN"],
          variables: [{ name: "REGION", value: "west" }],
        }],
      }),
      {
        repository: "sample",
        template: "code",
        environments: [{ name: "production" }],
      },
    ),
    { repository: "sample", operations: [] },
  );
});

Deno.test("explicit empty environment secrets clear them", () => {
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
          secrets: [],
        }],
      },
    ),
    {
      repository: "sample",
      operations: [{
        type: "update-environment",
        collections: "sparse",
        environment: {
          name: "production",
          secrets: [],
        },
      }],
    },
  );
});

Deno.test("new environments materialize omitted collections as empty", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      environments: [{ name: "staging" }],
    }),
    {
      repository: "sample",
      operations: [{
        type: "create-environment",
        environment: {
          name: "staging",
          secrets: [],
          variables: [],
        },
      }],
    },
  );
});

Deno.test("environments reject duplicate nested secret and variable names", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        environments: [{
          name: "production",
          secrets: ["TOKEN", "TOKEN"],
        }],
      }),
    Error,
    "Duplicate environment secret: TOKEN",
  );

  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        environments: [{
          name: "production",
          variables: [
            { name: "REGION", value: "west" },
            { name: "REGION", value: "north" },
          ],
        }],
      }),
    Error,
    "Duplicate environment variable: REGION",
  );
});
