import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  buildApplyEvaluations,
  buildPlan,
  createPersistedPlanArtifact,
  FetchGitHubClient,
  GitHubOwnerError,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  resolveDesiredState,
} from "@octosmith/octosmith";
import { createGitHubRuntime, main } from "../packages/cli/mod.ts";
import { type ApplyRuntime } from "../packages/cli/apply.ts";
import { applyPersistedPlan } from "../packages/cli/persisted.ts";
import { currentState } from "./plan/fixtures.ts";

Deno.test("online workflows reject unsupported or inaccessible owners before further API calls or bootstrap", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      "version: 1\norganization: acme\nrepositories:\n  scope:\n    include: all\n",
    );
    await Deno.writeTextFile(
      root + "/templates/default.yml",
      "version: 1\nkind: repository\nmatch:\n  include: all\nrepository: {}\n",
    );
    const loaded = await loadConfigurationDirectory(root);
    const artifact = await createPersistedPlanArtifact(loaded, []);
    const planPath = root + "/plan.json";
    await Deno.writeTextFile(planPath, JSON.stringify(artifact));
    for (
      const [response, expected] of [
        [
          Response.json({ login: "Acme", type: "User" }),
          "personal account (User)",
        ],
        [
          Response.json({ login: "Acme", type: "Bot" }),
          "unexpected account type",
        ],
        [Response.json({ message: "Not Found" }, { status: 404 }), "HTTP 404"],
        [Response.json({ message: "Forbidden" }, { status: 403 }), "HTTP 403"],
        [
          Response.json({ message: "Unavailable" }, { status: 500 }),
          "HTTP 500",
        ],
      ] as const
    ) {
      for (
        const command of [
          ["plan"],
          ["plan", "acme/repo"],
          ["apply"],
          ["apply", "repo"],
          ["apply", "--plan", planPath],
          [
            "resource",
            "create",
            "default",
            "--name",
            "repo",
            "--visibility",
            "private",
          ],
        ]
      ) {
        const calls: string[] = [];
        const output: string[] = [];
        const runtime = createGitHubRuntime({
          token: "test",
          fetch: (input, init) => {
            calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
            return Promise.resolve(response.clone());
          },
        });
        const code = await main([
          ...command,
          "--path",
          root,
          "--format",
          "json",
        ], {
          runtime,
          bootstrap: {
            bootstrap: () => {
              throw new Error("Bootstrap must not run for unsupported owners");
            },
          },
          write: (value) => output.push(value),
          writeError: (value) => output.push(value),
        });
        assertEquals(code, 1, command.join(" "));
        assertEquals(calls, ["GET /users/acme"]);
        assertStringIncludes(output.join("\n"), expected);
        assertStringIncludes(
          output.join("\n").toLowerCase(),
          "no changes were applied",
        );
      }
    }
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      "version: 1\norganization: personal-account\nrepositories:\n  scope:\n    include: all\n",
    );
    for (
      const command of [
        ["template", "validate"],
        [
          "resource",
          "create",
          "default",
          "--name",
          "repo",
          "--visibility",
          "private",
          "--dry-run",
        ],
      ]
    ) {
      assertEquals(
        await main([...command, "--path", root], {
          credentials: {
            getEnv: () => {
              throw new Error("Offline commands must not read credentials");
            },
          },
          fetch: () => {
            throw new Error("Offline commands must not access GitHub");
          },
          write: () => {},
        }),
        0,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("GitHub runtime reuses canonical organization identity across discoveries", async () => {
  const calls: string[] = [];
  const runtime = createGitHubRuntime({
    token: "test",
    fetch: (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path === "/users/acme") {
        return Promise.resolve(
          Response.json({ login: "Acme", type: "Organization" }),
        );
      }
      assertEquals(path, "/orgs/Acme/repos");
      return Promise.resolve(Response.json([]));
    },
  });
  const loaded = {
    root: ".",
    configuration: {
      version: 1 as const,
      organization: "acme",
      repositories: { scope: { include: "all" as const } },
    },
    templates: {},
  };
  assertEquals((await runtime.discover(loaded)).failures, []);
  assertEquals((await runtime.discover(loaded)).failures, []);
  assertEquals(calls, [
    "GET /users/acme",
    "GET /orgs/Acme/repos",
    "GET /orgs/Acme/repos",
  ]);
  assertEquals(loaded.configuration.organization, "acme");
});

Deno.test("saved plans cannot bypass the owner guard through a custom runtime", async () => {
  const loaded: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: { include: "all" },
        fileChanges: { mode: "direct" },
      },
    },
    templates: {
      "repository:default": {
        version: 1,
        kind: "repository",
        match: { include: "all" },
        repository: { settings: { hasIssues: false } },
      },
    },
  };
  const metadata = { name: "sample", teams: [], properties: {} };
  const desired = await resolveDesiredState(loaded, metadata, () => "unused");
  const current = currentState();
  const plan = buildPlan(current, desired);
  assertEquals(plan.operations.length > 0, true);
  const artifacts = [
    await createPersistedPlanArtifact(loaded, []),
    await createPersistedPlanArtifact(loaded, [{
      desired,
      current,
      plan,
      evaluations: buildApplyEvaluations(desired, plan.operations, current),
    }]),
  ];

  for (const artifact of artifacts) {
    const execution: string[] = [];
    const runtime: ApplyRuntime = {
      discover: () => {
        execution.push("discover");
        return Promise.resolve({ repositories: [metadata], failures: [] });
      },
      read: () => {
        execution.push("read");
        return Promise.resolve(current);
      },
      prepare: () => {
        execution.push("prepare");
      },
      recheck: () => {
        execution.push("recheck");
      },
      apply: () => {
        execution.push("apply");
        return Promise.resolve({ repository: "sample", operations: [] });
      },
    };
    await assertRejects(
      () => applyPersistedPlan(runtime, loaded, artifact, () => {}),
      GitHubOwnerError,
      "requires owner validation",
    );
    assertEquals(execution, []);
    for (
      const response of [
        Response.json({ login: "Acme", type: "User" }),
        Response.json({ login: "Acme", type: "Bot" }),
        Response.json({ message: "Forbidden" }, { status: 403 }),
      ]
    ) {
      const requests: string[] = [];
      const client = new FetchGitHubClient({
        token: "test",
        fetch: (input, init) => {
          requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
          return Promise.resolve(response.clone());
        },
      });
      await assertRejects(
        () =>
          applyPersistedPlan(
            { ...runtime, client },
            loaded,
            artifact,
            () => {},
          ),
        GitHubOwnerError,
      );
      assertEquals(requests, ["GET /users/acme"]);
      assertEquals(execution, []);
    }

    // An injected resolver supplies identity, not permission to bypass the guard.
    await assertRejects(
      () =>
        applyPersistedPlan(
          {
            ...runtime,
            resolveOwner: () =>
              Promise.resolve({ login: "Acme", type: "User" }),
          },
          loaded,
          artifact,
          () => {},
        ),
      GitHubOwnerError,
      "personal account",
    );
    assertEquals(execution, []);

    for (const mode of ["client", "resolver", "resolver-only"] as const) {
      execution.length = 0;
      const requests: string[] = [];
      let resolutions = 0;
      const client = new FetchGitHubClient({
        token: "test",
        fetch: (input) => {
          requests.push(new URL(String(input)).pathname);
          return Promise.resolve(
            Response.json({ login: "Acme", type: "Organization" }),
          );
        },
      });
      const result = await applyPersistedPlan(
        {
          ...runtime,
          ...(mode !== "resolver-only" && { client }),
          ...(mode !== "client" && {
            resolveOwner: (configuration: LoadedConfiguration) => {
              assertEquals(configuration, loaded);
              resolutions++;
              return Promise.resolve({
                login: "Acme",
                type: "Organization" as const,
              });
            },
          }),
        },
        loaded,
        artifact,
        () => {},
      );
      assertEquals(result.configuration, "valid");
      assertEquals(requests, mode === "client" ? ["/users/acme"] : []);
      assertEquals(resolutions, mode === "client" ? 0 : 1);
      assertEquals(
        execution,
        artifact.resources.length === 0
          ? []
          : ["discover", "read", "prepare", "recheck", "apply"],
      );
    }
  }
});
