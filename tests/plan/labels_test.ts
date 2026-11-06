import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/octosmith/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("labels create and update while preserving unlisted labels in explicit mode", () => {
  const current = currentState({
    labels: [
      { name: "security", color: "ffffff", description: "old" },
      { name: "unmanaged", color: "123456" },
    ],
  });
  const desired = {
    repository: "sample",
    template: "issues",
    labels: [
      { name: "security", color: "B60205", description: "Security findings" },
      { name: "severity:medium", color: "FBCA04" },
    ],
  } as const;
  const operations = [
    {
      type: "update-label",
      name: "security",
      label: {
        name: "security",
        color: "b60205",
        description: "Security findings",
      },
    },
    {
      type: "create-label",
      label: { name: "severity:medium", color: "fbca04" },
    },
  ] as const;
  assertEquals(buildPlan(current, desired).operations, operations);
  assertEquals(
    buildPlan(current, { ...desired, collections: "strict" }).operations,
    [
      { type: "delete-label", name: "unmanaged" },
      ...operations,
    ],
  );
});

Deno.test("omitted and empty labels remain unmanaged unless explicitly strict", () => {
  const current = currentState({ labels: [{ name: "bug", color: "123456" }] });
  const desired = { repository: "sample", template: "issues" } as const;
  assertEquals(
    buildPlan(current, { ...desired, collections: "strict" }).operations,
    [],
  );
  assertEquals(buildPlan(current, { ...desired, labels: [] }).operations, []);
  assertEquals(
    buildPlan(current, { ...desired, labels: [], collections: "strict" })
      .operations,
    [
      { type: "delete-label", name: "bug" },
    ],
  );
});

Deno.test("labels compare colors case-insensitively and preserve omitted descriptions", () => {
  const current = currentState({
    labels: [{ name: "security", color: "B60205", description: "keep" }],
  });
  const desired = {
    repository: "sample",
    template: "issues",
    labels: [{ name: "security", color: "b60205" }],
  };
  assertEquals(buildPlan(current, desired).operations, []);
  assertEquals(
    buildPlan(current, {
      ...desired,
      labels: [{ ...desired.labels[0], description: "" }],
    }).operations,
    [
      {
        type: "update-label",
        name: "security",
        label: { name: "security", color: "b60205", description: "" },
      },
    ],
  );
  assertEquals(
    buildPlan(current, {
      ...desired,
      labels: [{ name: "Security", color: "ffffff" }],
    }).operations,
    [
      {
        type: "update-label",
        name: "security",
        label: { name: "Security", color: "ffffff" },
      },
    ],
  );
});

Deno.test("labels reject duplicate case-insensitive identities", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "issues",
        labels: [{ name: "security", color: "b60205" }, {
          name: "Security",
          color: "ffffff",
        }],
      }),
    Error,
    "Duplicate label: security",
  );
});
