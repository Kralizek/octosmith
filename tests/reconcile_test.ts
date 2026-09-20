import { assertEquals, assertRejects } from "@std/assert";
import type {
  CurrentState,
  LoadedConfiguration,
  Plan,
  RepositoryMetadata,
} from "@octosmith/core";
import type {
  ApplyPlanResult,
  RepositoryDiscoveryFailure,
} from "@octosmith/github";
import {
  reconcile,
  type ReconciliationRuntime,
} from "../packages/cli/reconcile.ts";
import { currentRepositorySettings } from "./plan/fixtures.ts";

class FakeRuntime implements ReconciliationRuntime {
  readonly applied: Plan[] = [];
  readonly discoveredTargets: (string | undefined)[] = [];

  constructor(
    readonly repositories: readonly RepositoryMetadata[],
    readonly failRead = new Set<string>(),
    readonly discoveryFailures: readonly RepositoryDiscoveryFailure[] = [],
  ) {}

  discover(_loaded: LoadedConfiguration, repository?: string) {
    this.discoveredTargets.push(repository);
    return Promise.resolve({
      repositories: this.repositories,
      failures: this.discoveryFailures,
    });
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
        secrets: [],
        variables: [],
      },
      dependabot: { secrets: [] },
      teams: [],
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

Deno.test("reconcile rejects an empty repository target before discovery", async () => {
  const runtime = new FakeRuntime([]);

  await assertRejects(
    () =>
      reconcile(runtime, {
        path: "configuration-is-not-loaded",
        mode: "apply",
        repository: "",
      }),
    Error,
    "Repository target must not be empty",
  );

  assertEquals(runtime.discoveredTargets, []);
  assertEquals(runtime.applied, []);
});

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

Deno.test("reconcile returns a structured report without runtime values or file contents", async () => {
  const root = await sensitiveConfigurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const report = await reconcile(runtime, {
      path: root,
      mode: "plan",
      values: () => "runtime-private-value",
      now: sequentialClock(),
    });

    const serialized = JSON.stringify(report);

    assertEquals(serialized.includes("runtime-private-value"), false);
    assertEquals(serialized.includes("file-private-content"), false);
    assertEquals(serialized.includes("[redacted]"), false);
    assertEquals(serialized.includes("managed.txt"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile reports discovery failures without stopping other repositories", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime(
      [metadata("sample")],
      new Set(),
      [{ repository: "missing", error: new Error("not found") }],
    );
    const report = await reconcile(runtime, {
      path: root,
      mode: "plan",
      now: sequentialClock(),
    });

    assertEquals(
      report.repositories.map((item) => [item.repository, item.status]),
      [
        ["missing", "failed"],
        ["sample", "planned"],
      ],
    );
    assertEquals(report.repositories[0].error, "not found");
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
      'repositories: { scope: { names: ["*"] } }',
      "",
    ].join("\n"),
  );

  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "kind: repository",
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

async function sensitiveConfigurationDirectory(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await Deno.mkdir(root + "/files");

  await Deno.writeTextFile(
    root + "/octosmith.yml",
    [
      "version: 1",
      "organization: acme",
      'repositories: { scope: { names: ["sample"] } }',
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(root + "/files/managed.txt", "file-private-content");
  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "kind: repository",
      "match:",
      "  names:",
      "    - sample",
      "repository:",
      "  actions:",
      "    variables:",
      "      - REGION",
      "  files:",
      "    managed.txt:",
      "      ensure: exact",
      "      source: files/managed.txt",
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
