import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { stringify } from "@std/yaml";
import {
  applyPlan,
  buildPlan,
  type CurrentState,
  type DesiredState,
  type ExecutableResourcePlan,
  hashEffectiveConfiguration,
  loadConfigurationDirectory,
  MissingRuntimeValueError,
  parsePersistedPlanArtifact,
  resolveDesiredState,
} from "../packages/octosmith/mod.ts";
import { main } from "../packages/cli/mod.ts";
import type { ApplyRuntime } from "../packages/cli/apply.ts";
import { currentState } from "./plan/fixtures.ts";

const metadata = { name: "sample", teams: [], properties: {} };
const secretValue = "secret-material-must-never-be-serialized";
const flags = [[], ["--include-secrets"], ["--include-secrets=true"], [
  "--include-secrets=false",
]];

function policyCurrent(): CurrentState {
  return currentState({
    actions: { secrets: ["OLD_ACTIONS"], variables: [] },
    dependabot: { secrets: ["OLD_DEPENDABOT"] },
    environments: [
      { name: "production", secrets: ["OLD_ENV"], variables: [] },
      { name: "legacy", secrets: ["KEEP"], variables: [] },
      { name: "empty", secrets: [], variables: [] },
    ],
  });
}

function policyRuntime(current = policyCurrent()) {
  const sources: string[] = [];
  const desired: DesiredState[] = [];
  const executed: ExecutableResourcePlan[] = [];
  const runtime: ApplyRuntime = {
    value: (name) => {
      sources.push(name);
      return secretValue;
    },
    discover: () => Promise.resolve({ repositories: [metadata], failures: [] }),
    read: (state) => {
      desired.push(state);
      return Promise.resolve(current);
    },
    prepare: () => {},
    recheck: () => {},
    apply: (resource) => {
      executed.push(resource);
      return applyPlan({ apply: () => Promise.resolve() }, resource.plan);
    },
  };
  return { runtime, sources, desired, executed };
}

async function writePolicy(
  root: string,
  mode?: string,
  collections: "explicit" | "strict" = "strict",
) {
  await Deno.writeTextFile(
    root + "/octosmith.yml",
    stringify({
      version: 1,
      organization: "acme",
      repositories: {
        scope: { include: "all" },
        settings: {
          collection_management: collections,
          ...(mode !== undefined && { secrets: mode }),
        },
        file_changes: { mode: "direct" },
      },
    }),
  );
}

async function policyDirectory(
  mode?: string,
  collections: "explicit" | "strict" = "strict",
) {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await writePolicy(root, mode, collections);
  await Deno.writeTextFile(
    root + "/templates/default.yml",
    stringify({
      version: 1,
      kind: "repository",
      match: { include: "all" },
      repository: {
        settings: { has_issues: false },
        actions: {
          secrets: [{ from: "ACTIONS_SOURCE", to: "ACTIONS_TOKEN" }],
          variables: [{ name: "REGION", value: "east" }],
        },
        dependabot: { secrets: ["DEPENDABOT_TOKEN"] },
        environments: [{
          name: "production",
          secrets: ["ENV_TOKEN"],
          variables: [{ name: "REGION", value: "east" }],
        }, {
          name: "new",
          secrets: ["NEW_ENV_TOKEN"],
          variables: [{ name: "REGION", value: "east" }],
        }],
      },
    }),
  );
  return root;
}

for (const mode of [undefined, "automatic", "manual"] as const) {
  for (const collections of ["explicit", "strict"] as const) {
    for (const command of ["plan", "apply"]) {
      for (const flag of flags) {
        Deno.test(`${command} secrets ${mode ?? "default"}/${collections} ${flag.join(" ") || "omitted"}`, async () => {
          const root = await policyDirectory(mode, collections);
          try {
            const observed = policyRuntime();
            const output: string[] = [];
            const errors: string[] = [];
            assertEquals(
              await main(
                [command, "--path", root, "--format", "json", ...flag],
                {
                  runtime: observed.runtime,
                  write: (value) => output.push(value),
                  writeError: (value) => errors.push(value),
                },
              ),
              0,
              errors.join("\n"),
            );
            const included = mode !== "manual" ||
              flag[0] === "--include-secrets" ||
              flag[0] === "--include-secrets=true";
            const desired = observed.desired[0];
            assertEquals(
              desired.actions?.secrets?.length ?? 0,
              included ? 1 : 0,
            );
            assertEquals(
              desired.dependabot?.secrets?.length ?? 0,
              included ? 1 : 0,
            );
            assertEquals(
              desired.environments?.[0].secrets?.length ?? 0,
              included ? 1 : 0,
            );
            assertEquals(
              desired.environments?.[1].secrets?.length ?? 0,
              included ? 1 : 0,
            );
            assertEquals(observed.sources.length, included ? 4 : 0);
            const operations = buildPlan(policyCurrent(), desired).operations;
            assertEquals(
              operations.some((operation) =>
                operation.type === "set-actions-secret"
              ),
              included,
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "set-dependabot-secret"
              ),
              included,
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "remove-actions-secret"
              ),
              included && collections === "strict",
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "remove-dependabot-secret"
              ),
              included && collections === "strict",
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "delete-environment" &&
                operation.name === "legacy"
              ),
              included && collections === "strict",
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "delete-environment" &&
                operation.name === "empty"
              ),
              collections === "strict",
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "update-repository-settings"
              ),
              true,
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "set-actions-variable"
              ),
              true,
            );
            assertEquals(
              operations.some((operation) =>
                operation.type === "update-environment"
              ),
              true,
            );
            const report = JSON.parse(output.join("\n"));
            assertEquals(
              report.repositories[0].diagnostics?.some((
                diagnostic: { code: string },
              ) => diagnostic.code === "excluded_secrets") ?? false,
              !included,
            );
            assertEquals(output.join("\n").includes(secretValue), false);
            if (command === "apply") {
              assertEquals(observed.executed[0].plan.operations, operations);
            }
          } finally {
            await Deno.remove(root, { recursive: true });
          }
        });
      }
    }
  }
}

for (const command of ["plan", "apply"]) {
  for (const value of ["yes", "1", "maybe", ""]) {
    Deno.test(`${command} rejects include-secrets=${value}`, async () => {
      const errors: string[] = [];
      assertEquals(
        await main([command, `--include-secrets=${value}`], {
          writeError: (value) => errors.push(value),
        }),
        1,
      );
      assertStringIncludes(errors.join("\n"), "boolean");
    });
  }
}

for (const mode of ["automatic", "manual"]) {
  for (const include of [false, true]) {
    for (const skip of [false, true]) {
      for (const command of ["plan", "apply"]) {
        Deno.test(`${command} missing secret providers ${mode}, include=${include}, skip=${skip}`, async () => {
          const root = await policyDirectory(mode);
          try {
            const observed = policyRuntime();
            let lookups = 0;
            const output: string[] = [];
            const errors: string[] = [];
            const included = mode === "automatic" || include;
            assertEquals(
              await main([
                command,
                "--path",
                root,
                `--include-secrets=${include}`,
                ...(skip ? ["--skip-missing-values"] : []),
              ], {
                runtime: {
                  ...observed.runtime,
                  value: (name) => {
                    lookups++;
                    throw new MissingRuntimeValueError(name);
                  },
                },
                write: (value) => output.push(value),
                writeError: (value) => errors.push(value),
              }),
              included && !skip ? 1 : 0,
              errors.join("\n"),
            );
            assertEquals(lookups > 0, included);
            if (!included) {
              assertStringIncludes(
                output.join("\n"),
                "Secrets excluded (manual mode)",
              );
              assertEquals(output.join("\n").includes("ACTIONS_SOURCE"), false);
              assertEquals(
                output.join("\n").includes("skipped runtime bindings"),
                true,
              );
            }
            if (included && skip && command === "apply") {
              assertEquals(
                observed.executed[0].skippedRuntimeReferences?.length,
                4,
              );
            }
          } finally {
            await Deno.remove(root, { recursive: true });
          }
        });
      }
    }
  }
}

for (const originalMode of ["automatic", "manual"] as const) {
  for (const flag of flags) {
    Deno.test(`persisted ${originalMode} plan ignores switched policy and ${flag.join(" ") || "omitted flag"}`, async () => {
      const root = await policyDirectory(originalMode);
      try {
        const path = root + "/plan.json";
        const planned = policyRuntime();
        assertEquals(
          await main(["plan", "--path", root, "--out", path, "--quiet"], {
            runtime: planned.runtime,
          }),
          0,
        );
        const serialized = await Deno.readTextFile(path);
        assertEquals(serialized.includes(secretValue), false);
        const artifact = parsePersistedPlanArtifact(JSON.parse(serialized));
        assertEquals(artifact.version, 1);
        assertEquals(
          artifact.resources[0].secretsExcluded,
          originalMode === "manual" ? true : undefined,
        );
        const before = await loadConfigurationDirectory(root);
        await writePolicy(
          root,
          originalMode === "automatic" ? "manual" : "automatic",
        );
        const after = await loadConfigurationDirectory(root);
        assertEquals(
          await hashEffectiveConfiguration(before.configuration),
          await hashEffectiveConfiguration(after.configuration),
        );
        const replay = policyRuntime();
        const output: string[] = [];
        assertEquals(
          await main(["apply", "--path", root, "--plan", path, ...flag], {
            runtime: replay.runtime,
            write: (value) => output.push(value),
          }),
          0,
        );
        assertEquals(
          replay.executed[0].plan.operations,
          artifact.resources[0].operations,
        );
        assertEquals(
          replay.sources.length,
          originalMode === "automatic" ? 4 : 0,
        );
        assertEquals(output.join("\n").includes(secretValue), false);
        const failures = policyRuntime();
        await Deno.writeTextFile(
          root + "/templates/default.yml",
          (await Deno.readTextFile(root + "/templates/default.yml")).replace(
            "has_issues: false",
            "has_issues: true",
          ),
        );
        assertEquals(
          await main(["apply", "--path", root, "--plan", path, "--quiet"], {
            runtime: failures.runtime,
            writeError: () => {},
          }),
          1,
        );
        assertEquals(failures.executed.length, 0);
        assertNotEquals(
          await hashEffectiveConfiguration(after.configuration),
          await hashEffectiveConfiguration({
            ...after.configuration,
            organization: "changed",
          }),
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

Deno.test("manual saved plans ignore secret drift but retain state and execution safeguards", async () => {
  const root = await policyDirectory("manual");
  try {
    const path = root + "/plan.json";
    assertEquals(
      await main(["plan", "--path", root, "--out", path, "--quiet"], {
        runtime: policyRuntime().runtime,
      }),
      0,
    );
    const original = policyCurrent();
    const changedSecrets = {
      ...original,
      actions: { ...original.actions, secrets: ["CHANGED_ACTIONS"] },
      dependabot: { secrets: ["CHANGED_DEPENDABOT"] },
      environments: original.environments.map((environment) => ({
        ...environment,
        secrets: environment.secrets.length > 0 ? ["CHANGED_ENV"] : [],
      })),
    };
    const replay = policyRuntime(changedSecrets);
    assertEquals(
      await main(["apply", "--path", root, "--plan", path, "--quiet"], {
        runtime: {
          ...replay.runtime,
          value: () => {
            throw new Error("No secret inputs required");
          },
        },
      }),
      0,
    );
    assertEquals(replay.executed.length, 1);

    const staleStates = [
      {
        ...original,
        actions: {
          ...original.actions,
          variables: [{ name: "REGION", value: "changed" }],
        },
      },
      {
        ...original,
        environments: original.environments.map((environment) =>
          environment.name === "empty"
            ? { ...environment, secrets: ["NEW_SECRET"] }
            : environment
        ),
      },
      {
        ...original,
        environments: original.environments.map((environment) =>
          environment.name === "production"
            ? {
              ...environment,
              variables: [{ name: "REGION", value: "changed" }],
            }
            : environment
        ),
      },
    ];
    for (const state of staleStates) {
      const observed = policyRuntime(state);
      assertEquals(
        await main(["apply", "--path", root, "--plan", path, "--quiet"], {
          runtime: observed.runtime,
          writeError: () => {},
        }),
        1,
      );
      assertEquals(observed.executed.length, 0);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("manual plans explicitly including secrets retain runtime requirements during replay", async () => {
  const root = await policyDirectory("manual");
  try {
    const path = root + "/plan.json";
    assertEquals(
      await main([
        "plan",
        "--path",
        root,
        "--include-secrets",
        "--out",
        path,
        "--quiet",
      ], {
        runtime: policyRuntime().runtime,
      }),
      0,
    );
    const observed = policyRuntime();
    const errors: string[] = [];
    assertEquals(
      await main([
        "apply",
        "--path",
        root,
        "--plan",
        path,
        "--include-secrets=false",
        "--quiet",
      ], {
        runtime: {
          ...observed.runtime,
          value: (name) => {
            throw new MissingRuntimeValueError(name);
          },
        },
        writeError: (value) => errors.push(value),
      }),
      1,
    );
    assertEquals(observed.executed.length, 0);
    assertStringIncludes(errors.join("\n"), "Missing environment value");
    assertEquals(
      await main([
        "apply",
        "--path",
        root,
        "--plan",
        path,
        "--include-secrets=false",
        "--quiet",
      ], {
        runtime: observed.runtime,
      }),
      0,
    );
    assertEquals(observed.executed.length, 1);
    assertEquals(observed.sources.length, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("secret mode schema validation and core default normalization", async () => {
  const root = await policyDirectory();
  try {
    for (const mode of [undefined, "automatic", "manual"] as const) {
      await writePolicy(root, mode);
      const loaded = await loadConfigurationDirectory(root);
      const desired = await resolveDesiredState(
        loaded,
        metadata,
        () => secretValue,
      );
      assertEquals(
        desired.secretsExcluded,
        mode === "manual" ? true : undefined,
      );
    }
    for (const invalid of ["sometimes", "", "true"]) {
      await writePolicy(root, invalid);
      await assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        "secrets",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
