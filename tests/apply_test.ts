import { assertEquals, assertRejects } from "@std/assert";
import {
  type CurrentState,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  type Plan,
  type RepositoryMetadata,
  type RepositoryReport,
  MissingRuntimeValueError,
} from "@octosmith/octosmith";
import type {
  ApplyPlanResult,
  RepositoryDiscoveryFailure,
} from "@octosmith/octosmith";
import { apply, type ApplyRuntime } from "../packages/cli/apply.ts";
import { currentRepositorySettings } from "./plan/fixtures.ts";

class FakeRuntime implements ApplyRuntime {
  readonly applied: Plan[] = [];
  readonly discoveredTargets: (string | undefined)[] = [];
  readonly readRepositories: string[] = [];

  constructor(
    readonly repositories: readonly RepositoryMetadata[],
    readonly failRead = new Set<string>(),
    readonly discoveryFailures: readonly RepositoryDiscoveryFailure[] = [],
    readonly staleOnRecheck = new Set<string>(),
  ) {}

  discover(_loaded: LoadedConfiguration, repository?: string) {
    this.discoveredTargets.push(repository);
    return Promise.resolve({
      repositories: this.repositories,
      failures: this.discoveryFailures,
    });
  }

  read(
    desired: import("@octosmith/octosmith").DesiredState,
  ): Promise<CurrentState> {
    this.readRepositories.push(desired.repository);
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

  prepare(_resource: import("@octosmith/octosmith").ExecutableResourcePlan) {}

  async recheck(
    resource: import("@octosmith/octosmith").ExecutableResourcePlan,
  ) {
    await this.read(resource.desired);
    if (this.staleOnRecheck.has(resource.desired.repository)) {
      throw new Error("Resource state changed after apply preparation");
    }
  }

  apply(
    resource: import("@octosmith/octosmith").ExecutableResourcePlan,
  ): Promise<ApplyPlanResult> {
    const plan = resource.plan;
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

Deno.test("apply rejects an empty resource target before discovery", async () => {
  const runtime = new FakeRuntime([]);

  await assertRejects(
    () =>
      apply(
        runtime,
        {} as LoadedConfiguration,
        {
          mode: "apply",
          resource: "",
          onRepositoryApplied: () => {},
        },
      ),
    Error,
    "Resource target must not be empty",
  );

  assertEquals(runtime.discoveredTargets, []);
  assertEquals(runtime.applied, []);
});

Deno.test("apply rejects resource and template targets before discovery", async () => {
  const runtime = new FakeRuntime([]);
  const root = await configurationDirectory();
  try {
    const loaded = await loadConfigurationDirectory(root);
    await assertRejects(
      () =>
        apply(runtime, loaded, {
          mode: "plan",
          resource: "sample",
          template: "repository:code",
          onRepositoryApplied: () => {},
        }),
      Error,
      "Cannot combine a template filter with a repository target",
    );

    assertEquals(runtime.discoveredTargets, []);
    assertEquals(runtime.applied, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
  },
);

Deno.test("apply rejects an unknown template before discovery", async () => {
  const runtime = new FakeRuntime([]);
  const root = await configurationDirectory();
  try {
    const loaded = await loadConfigurationDirectory(root);
    await assertRejects(
      () =>
        apply(runtime, loaded, {
          mode: "plan",
          template: "repository:missing",
          onRepositoryApplied: () => {},
        }),
      Error,
      "Unknown template: repository:missing",
    );

    assertEquals(runtime.discoveredTargets, []);
    assertEquals(runtime.applied, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply plan builds reports without applying", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const results = await applyResults(runtime, root, "plan");

    assertEquals(results[0].status, "planned");
    assertEquals(runtime.applied, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply apply executes the fresh plan", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const results = await applyResults(runtime, root, "apply");

    assertEquals(results[0].status, "applied");
    assertEquals(runtime.applied.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test(
  "skip-missing-values preserves unavailable runtime values in plan and apply",
  async () => {
    const root = await runtimeValuesConfigurationDirectory();
    try {
      for (const mode of ["plan", "apply"] as const) {
        const runtime = new FakeRuntime([metadata("sample")]);
        const loaded = await loadConfigurationDirectory(root);
        const results: RepositoryReport[] = [];
        const planned: Plan[] = [];

        await apply(runtime, loaded, {
          mode,
          skipMissingValues: true,
          values: (name) => {
            if (name === "AVAILABLE") return "";
            throw new MissingRuntimeValueError(name);
          },
          onRepositoryApplied: (report) => {
            results.push(report);
          },
          onPlanBuilt: (resource) => {
            planned.push(resource.plan);
          },
        });

        const report = results[0];
        assertEquals(report.diagnostics?.length, 5);
        assertEquals(
          report.diagnostics?.every((diagnostic) =>
            diagnostic.severity === "warning" &&
            diagnostic.code.startsWith("skipped_")
          ),
          true,
        );
        assertEquals(report.diagnostics?.[0].name, "MISSING_VARIABLE");
        assertEquals(planned.length, 1);
        assertEquals(planned[0].operations, [{
          type: "set-actions-variable",
          variable: { name: "AVAILABLE", value: "" },
        }]);
        if (mode === "apply") {
          assertEquals(runtime.applied[0].operations, [{
            type: "set-actions-variable",
            variable: { name: "AVAILABLE", value: "" },
          }]);
        }
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
});

Deno.test("skip-missing-values does not swallow other runtime failures", async () => {
  const root = await runtimeValuesConfigurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const loaded = await loadConfigurationDirectory(root);
    const results: RepositoryReport[] = [];

    await apply(runtime, loaded, {
      mode: "plan",
      skipMissingValues: true,
      values: () => {
        throw new Error("provider outage");
      },
      onRepositoryApplied: (report) => {
        results.push(report);
      },
    });

    assertEquals(results[0].status, "failed");
    assertEquals(results[0].error, "provider outage");
    assertEquals(results[0].diagnostics, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("template-scoped plan resolves only classified repositories", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([
      metadata("broken"),
      metadata("sample"),
      metadata("unmatched"),
    ]);
    const loaded = await loadConfigurationDirectory(root);
    const results: RepositoryReport[] = [];

    await apply(runtime, loaded, {
      mode: "plan",
      template: "repository:code",
      onRepositoryApplied: (report) => {
        results.push(report);
      },
    });

    assertEquals(runtime.readRepositories, ["broken", "sample"]);
    assertEquals(results.map((result) => result.repository), [
      "broken",
      "sample",
    ]);
    assertEquals(results.every((result) => result.status === "planned"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("template-scoped plan is a successful no-op without matches", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("other")]);
    const loaded = await loadConfigurationDirectory(root);
    const results: RepositoryReport[] = [];

    await apply(runtime, loaded, {
      mode: "plan",
      template: "repository:code",
      onRepositoryApplied: (report) => {
        results.push(report);
      },
    });

    assertEquals(runtime.readRepositories, []);
    assertEquals(results, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fresh apply rechecks the first resource after all resources are prepared", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime(
      [metadata("sample"), metadata("broken")],
      new Set(),
      [],
      new Set(["sample"]),
    );
    const results = await applyResults(runtime, root, "apply");

    assertEquals(runtime.applied, []);
    assertEquals(results[0].status, "failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fresh apply prepares all resources before the first mutation", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime(
      [metadata("sample"), metadata("broken")],
      new Set(["broken"]),
    );
    const results = await applyResults(runtime, root, "apply");

    assertEquals(runtime.applied, []);
    assertEquals(
      results.map((item) => [item.repository, item.status]),
      [
        ["broken", "failed"],
        ["sample", "failed"],
      ],
    );
    assertEquals(
      results.find((item) => item.repository === "sample")?.error,
      "Apply aborted before mutation because another resource failed during preparation",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply returns a structured report without runtime values or file contents", async () => {
  const root = await sensitiveConfigurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const loaded = await loadConfigurationDirectory(root);
    const results: RepositoryReport[] = [];
    await apply(runtime, loaded, {
      mode: "plan",
      values: () => "runtime-private-value",
      onRepositoryApplied: (report) => {
        results.push(report);
      },
    });

    const serialized = JSON.stringify(results);

    assertEquals(serialized.includes("runtime-private-value"), false);
    assertEquals(serialized.includes("file-private-content"), false);
    assertEquals(serialized.includes("[redacted]"), false);
    assertEquals(serialized.includes("managed.txt"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply reports discovery failures without stopping other repositories", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime(
      [metadata("sample")],
      new Set(),
      [{ repository: "missing", error: new Error("not found") }],
    );
    const results = await applyResults(runtime, root, "plan");

    assertEquals(
      results.map((item) => [item.repository, item.status]),
      [
        ["missing", "failed"],
        ["sample", "planned"],
      ],
    );
    assertEquals(results[0].error, "not found");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply ignores unmatched repositories when configured", async () => {
  const root = await configurationDirectory({
    unmatchedRepositories: "ignore",
  });
  try {
    const runtime = new FakeRuntime([
      metadata("unmatched"),
      metadata("sample"),
    ]);
    const results = await applyResults(runtime, root, "plan");

    assertEquals(
      results.map((item) => [item.repository, item.status]),
      [["sample", "planned"]],
    );
    assertEquals(runtime.applied, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply invokes completion callback exactly once when callback fails", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime([metadata("sample")]);
    const loaded = await loadConfigurationDirectory(root);
    let calls = 0;

    await assertRejects(
      () =>
        apply(runtime, loaded, {
          mode: "plan",
          onRepositoryApplied: () => {
            calls++;
            throw new Error("event write failed");
          },
        }),
      Error,
      "event write failed",
    );

    assertEquals(calls, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("apply isolates repository failures", async () => {
  const root = await configurationDirectory();
  try {
    const runtime = new FakeRuntime(
      [metadata("broken"), metadata("sample")],
      new Set(["broken"]),
    );
    const results = await applyResults(runtime, root, "plan");

    assertEquals(
      results.map((item) => item.status),
      ["failed", "planned"],
    );
    assertEquals(results[0].error, "read failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function configurationDirectory(
  settings?: { readonly unmatchedRepositories?: "error" | "ignore" },
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");

  await Deno.writeTextFile(
    root + "/octosmith.yml",
    [
      "version: 1",
      "organization: acme",
      "repositories:",
      '  scope: { include: { names: ["*"] } }',
      ...(settings?.unmatchedRepositories !== undefined
        ? [
          "  settings:",
          "    unmatched_repositories: " + settings.unmatchedRepositories,
        ]
        : []),
      "",
    ].join("\n"),
  );

  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "      - broken",
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
      'repositories: { scope: { include: { names: ["sample"] } } }',
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(root + "/files/managed.txt", "file-private-content");
  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
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

async function runtimeValuesConfigurationDirectory(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await Deno.writeTextFile(
    root + "/octosmith.yml",
    [
      "version: 1",
      "organization: acme",
      "repositories:",
      '  scope: { include: { names: ["sample"] } }',
      "  settings:",
      "    collection_management: strict",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "version: 1",
      "kind: repository",
      "match:",
      '  include: { names: ["sample"] }',
      "repository:",
      "  actions:",
      "    variables: [AVAILABLE, MISSING_VARIABLE]",
      "    secrets: [MISSING_ACTIONS_SECRET]",
      "  dependabot:",
      "    secrets: [MISSING_DEPENDABOT_SECRET]",
      "  environments:",
      "    - name: production",
      "      variables: [MISSING_ENVIRONMENT_VARIABLE]",
      "      secrets: [MISSING_ENVIRONMENT_SECRET]",
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

async function applyResults(
  runtime: ApplyRuntime,
  root: string,
  mode: "plan" | "apply",
): Promise<RepositoryReport[]> {
  const loaded = await loadConfigurationDirectory(root);
  const results: RepositoryReport[] = [];

  await apply(runtime, loaded, {
    mode,
    onRepositoryApplied: (report) => {
      results.push(report);
    },
  });

  return results;
}
