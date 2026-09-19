import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/core/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("files create missing exact and exists files", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      files: [
        { path: "EXACT.md", ensure: "exact", content: "exact" },
        { path: "EXISTS.md", ensure: "exists", content: "seed" },
      ],
    }),
    {
      repository: "sample",
      operations: [
        {
          type: "create-file",
          file: { path: "EXACT.md", ensure: "exact", content: "exact" },
        },
        {
          type: "create-file",
          file: { path: "EXISTS.md", ensure: "exists", content: "seed" },
        },
      ],
    },
  );
});

Deno.test("exact files update drift and noop on identical content", () => {
  const current = currentState({
    files: [
      { path: "same.md", content: "same", sha: "same-sha" },
      { path: "change.md", content: "old", sha: "change-sha" },
    ],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      files: [
        { path: "same.md", ensure: "exact", content: "same" },
        { path: "change.md", ensure: "exact", content: "new" },
      ],
    }),
    {
      repository: "sample",
      operations: [{
        type: "update-file",
        sha: "change-sha",
        file: { path: "change.md", ensure: "exact", content: "new" },
      }],
    },
  );
});

Deno.test("exists never overwrites and absent deletes only when present", () => {
  const current = currentState({
    files: [
      { path: "keep.md", content: "custom", sha: "keep-sha" },
      { path: "remove.md", content: "x", sha: "remove-sha" },
    ],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      files: [
        { path: "keep.md", ensure: "exists", content: "seed" },
        { path: "remove.md", ensure: "absent" },
        { path: "missing.md", ensure: "absent" },
      ],
    }),
    {
      repository: "sample",
      operations: [{
        type: "delete-file",
        path: "remove.md",
        sha: "remove-sha",
      }],
    },
  );
});

Deno.test("strict collections never infer file deletion", () => {
  assertEquals(
    buildPlan(
      currentState({
        files: [{ path: "README.md", content: "x", sha: "sha" }],
      }),
      {
        repository: "sample",
        template: "code",
        collections: "strict",
        files: [],
      },
    ),
    { repository: "sample", operations: [] },
  );
});

Deno.test("files reject duplicate paths", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        files: [
          { path: "README.md", ensure: "exact", content: "a" },
          { path: "README.md", ensure: "exists", content: "b" },
        ],
      }),
    Error,
    "Duplicate file: README.md",
  );
});
