import { assertEquals } from "@std/assert";
import type {
  CurrentState,
  LoadedConfiguration,
  Plan,
  RepositoryMetadata,
} from "@octosmith/core";
import type { ApplyPlanResult } from "@octosmith/github";
import {
  reconcile,
  type ReconciliationRuntime,
} from "../packages/cli/reconcile.ts";
import { currentRepositorySettings } from "./plan/fixtures.ts";

class FakeRuntime implements ReconciliationRuntime {
  readonly applied: Plan[] = [];

  constructor(
    readonly repositories: readonly RepositoryMetadata[],
    readonly failRead = new Set<string>(),
  ) {}

  discover(_loaded: LoadedConfiguration) {
    return Promise.resolve(this.repositories);
  }

  read(desired: import("@octosmith/core").DesiredState): Promise<CurrentState> {
    if (this.failRead.has(desired.repository)) {
      return Promise.reject(new Error("read failed"));
    }

    return Promise.resolve({
      repository: desired.repository,
      settings: currentRepositorySettings(),
      customProperties: {},
      actions: {
        enabled: true,
        allowedActions: "all",
        shaPinningRequired: false,
        oidc: {
          subjectClaimTemplate: { source: "default" },
          immutableSubject: false,
        },
      },
      teams: [],
      secrets: [],
      variables: [],
      rulesets: [],
      environments: [],
      files: [],
    });
  }

  apply(plan: Plan): Promise<ApplyPlanResult> {
    this.applied.push(plan);

    return Promise.resolve({
      repository: plan.repository,
      operations: plan.operations.map((operation) => ({
        operation,
        status: "applied" as const,
      })),
    });
  }
}

Deno.test("reconcile plan builds reports without applying", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const report = await reconcile(runtime, {
      path: root,
      mode: "plan",
      now: sequentialClock(),
    });

    assertEquals(report.repositories[0].status, "planned");
    assertEquals(runtime.applied, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile apply executes the fresh plan", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const report = await reconcile(runtime, {
      path: root,
      mode: "apply",
      now: sequentialClock(),
    });

    assertEquals(report.repositories[0].status, "applied");
    assertEquals(runtime.applied.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile isolates repository failures", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime(
      [metadata("broken"), metadata("sample")],
      new Set(["broken"]),
    );
    const report = await reconcile(runtime, {
      path: root,
      mode: "plan",
      now: sequentialClock(),
    });

    assertEquals(
      report.repositories.map((item) => item.status),
      ["failed", "planned"],
    );
    assertEquals(report.repositories[0].error, "read failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function configurationDirectory(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");

  await Deno.writeTextFile(
    root + "/octosmith.yml",
    [
      "version: 1",
      "organization: acme",
      "scope: {}",
      "",
    ].join("\n"),
  );

  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "match:",
      "  names:",
      "    - sample",
      "    - broken",
      "repository:",
      "  settings:",
      "    has_issues: false",
      "",
    ].join("\n"),
  );

  return root;
}

function metadata(name: string): RepositoryMetadata {
  return {
    name,
    teams: [],
    visibility: "private",
    properties: {},
  };
}

function sequentialClock(): () => Date {
  let tick = 0;
  return () => new Date(1_000 + tick++ * 1_000);
}
