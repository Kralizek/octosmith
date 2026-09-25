import { assertEquals, assertThrows } from "@std/assert";
import {
  buildPlan,
  fileExecutionBranch,
  type Operation,
} from "../../packages/octosmith/mod.ts";
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

Deno.test("file planning requires a snapshot of the effective branch", () => {
  const desired = {
    repository: "sample",
    template: "code",
    settings: { defaultBranch: "release" },
    files: [{ path: "managed.txt", ensure: "exact" as const, content: "new" }],
  };
  assertThrows(
    () => buildPlan(currentState(), desired),
    Error,
    "snapshot does not match",
  );
  const plan = buildPlan(
    currentState({
      filesBranch: "release",
      files: [{ path: "managed.txt", content: "old", sha: "release-sha" }],
    }),
    desired,
  );
  assertEquals(plan.operations[1], {
    type: "update-file",
    sha: "release-sha",
    file: desired.files[0],
  });
});

Deno.test("batched file operations consume one ordered execution branch", () => {
  const file: Operation = {
    type: "create-file",
    file: { path: "managed.txt", ensure: "exact", content: "new" },
  };
  const change: Operation = {
    type: "update-repository-settings",
    settings: { defaultBranch: "release" },
  };
  assertEquals(fileExecutionBranch("main", [change, file]), "release");
  assertEquals(fileExecutionBranch("main", [file, change]), "main");
  assertThrows(
    () => fileExecutionBranch("main", [file, change, file]),
    Error,
    "one execution branch",
  );
});
