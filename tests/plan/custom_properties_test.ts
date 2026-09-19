import { assertEquals } from "@std/assert";
import { buildPlan } from "../../packages/core/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("custom properties compare string arrays as unordered", () => {
  assertEquals(
    buildPlan(
      currentState({ customProperties: { regions: ["eu", "us"] } }),
      {
        repository: "sample",
        template: "code",
        customProperties: { regions: ["us", "eu"] },
      },
    ),
    { repository: "sample", operations: [] },
  );
});

Deno.test("custom properties set missing, changed and null values", () => {
  assertEquals(
    buildPlan(
      currentState({ customProperties: { remove: "value" } }),
      {
        repository: "sample",
        template: "code",
        customProperties: {
          add: "value",
          remove: null,
        },
      },
    ),
    {
      repository: "sample",
      operations: [
        { type: "set-custom-property", name: "add", value: "value" },
        { type: "set-custom-property", name: "remove", value: null },
      ],
    },
  );
});

Deno.test("strict custom properties clear undeclared current values", () => {
  const current = currentState({
    customProperties: { keep: "same", remove: "value", alreadyNull: null },
  });
  const desired = {
    repository: "sample",
    template: "code",
    customProperties: { keep: "same" },
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });
  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "set-custom-property", name: "remove", value: null },
    ],
  });
});
