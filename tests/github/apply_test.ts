import { assertEquals } from "@std/assert";
import type { Operation, Plan } from "@octosmith/core";
import { applyPlan, type RepositoryMutationSink } from "@octosmith/github";

class FakeSink implements RepositoryMutationSink {
  readonly calls: string[] = [];

  constructor(readonly failOn?: string) {}

  apply(repository: string, operation: Operation): Promise<void> {
    this.calls.push(repository + ":" + operation.type);

    if (operation.type === this.failOn) {
      return Promise.reject(new Error("boom:" + operation.type));
    }

    return Promise.resolve();
  }
}

Deno.test("applyPlan executes operations sequentially", async () => {
  const sink = new FakeSink();
  const plan = samplePlan();

  const result = await applyPlan(sink, plan);

  assertEquals(sink.calls, [
    "sample:update-repository-settings",
    "sample:set-custom-property",
    "sample:create-file",
  ]);
  assertEquals(
    result.operations.map((item) => item.status),
    ["applied", "applied", "applied"],
  );
});

Deno.test("applyPlan waits for each operation to finish before starting the next", async () => {
  let releaseFirst!: () => void;
  const firstCompleted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started: string[] = [];

  const sink: RepositoryMutationSink = {
    async apply(_repository, operation) {
      started.push(operation.type);

      if (started.length === 1) {
        await firstCompleted;
      }
    },
  };

  const applying = applyPlan(sink, samplePlan());

  await Promise.resolve();
  assertEquals(started, ["update-repository-settings"]);

  releaseFirst();
  const result = await applying;

  assertEquals(started, [
    "update-repository-settings",
    "set-custom-property",
    "create-file",
  ]);
  assertEquals(
    result.operations.map((operation) => operation.status),
    ["applied", "applied", "applied"],
  );
});

Deno.test("applyPlan preserves partial results and skips remaining work after failure", async () => {
  const sink = new FakeSink("set-custom-property");

  const result = await applyPlan(sink, samplePlan());

  assertEquals(sink.calls, [
    "sample:update-repository-settings",
    "sample:set-custom-property",
  ]);
  assertEquals(result.operations, [
    {
      operation: samplePlan().operations[0],
      status: "applied",
    },
    {
      operation: samplePlan().operations[1],
      status: "failed",
      error: "boom:set-custom-property",
    },
    {
      operation: samplePlan().operations[2],
      status: "skipped",
    },
  ]);
});

Deno.test("applyPlan can continue after a failed operation", async () => {
  const sink = new FakeSink("set-custom-property");

  const result = await applyPlan(
    sink,
    samplePlan(),
    { continueOnError: true },
  );

  assertEquals(sink.calls, [
    "sample:update-repository-settings",
    "sample:set-custom-property",
    "sample:create-file",
  ]);
  assertEquals(
    result.operations.map((item) => item.status),
    ["applied", "failed", "applied"],
  );
});

Deno.test("applyPlan handles empty plans", async () => {
  const sink = new FakeSink();

  assertEquals(
    await applyPlan(sink, { repository: "sample", operations: [] }),
    {
      repository: "sample",
      operations: [],
    },
  );
  assertEquals(sink.calls, []);
});

function samplePlan(): Plan {
  return {
    repository: "sample",
    operations: [
      {
        type: "update-repository-settings",
        settings: { hasIssues: false },
      },
      {
        type: "set-custom-property",
        name: "tier",
        value: "critical",
      },
      {
        type: "create-file",
        file: {
          path: "README.md",
          ensure: "exists",
          content: "seed",
        },
      },
    ],
  };
}
