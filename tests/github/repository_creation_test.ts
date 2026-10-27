import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import sodium from "libsodium-wrappers";
import {
  buildApplyEvaluations,
  buildPlan,
  classifyResource,
  createRepository,
  discoverRepositories,
  FetchGitHubClient,
  GitHubRepositoryMutationSink,
  GitHubRepositoryStateSource,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  readCurrentState,
  renderRepositoryCreationResult,
  type RepositoryConfiguration,
  type RepositoryCreationRequest,
  requiredPermissionsForConfiguration,
  requiredPermissionsForRepositoryCreation,
  resolveDesiredState,
} from "@octosmith/octosmith";
import { main } from "../../packages/cli/mod.ts";
import { currentState } from "../plan/fixtures.ts";

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

class GitHub {
  readonly calls: Call[] = [];
  exists = false;
  name = "api-orders";
  visibility = "internal";
  teams: { slug: string; permission: string }[] = [];
  properties: { property_name: string; value: unknown }[] = [];
  settings: Record<string, unknown> = {};
  override?: (call: Call) => Response | undefined;
  readonly fetch: typeof globalThis.fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      ...(init?.body && { body: JSON.parse(String(init.body)) }),
    };
    this.calls.push(call);
    const overridden = this.override?.(call);
    if (overridden) return Promise.resolve(overridden);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(Response.json(body, { status }));
    if (call.method === "POST" && path === "/orgs/acme/repos") {
      this.exists = true;
      this.name = String(call.body?.name);
      this.visibility = String(call.body?.visibility);
      return json(this.repository(), 201);
    }
    if (/^\/repos\/acme\/[^/]+$/.test(path)) {
      if (call.method === "GET") {
        return this.exists && path.endsWith("/" + this.name)
          ? json(this.repository())
          : json({ message: "Not Found" }, 404);
      }
      if (call.method === "PATCH") {
        Object.assign(this.settings, call.body);
        return json(this.repository());
      }
    }
    if (call.method === "PUT" && path.includes("/teams/")) {
      const team = path.split("/")[4];
      this.teams = this.teams.filter(({ slug }) => slug !== team);
      this.teams.push({
        slug: team,
        permission: String(call.body?.permission),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path.endsWith("/properties/values")) {
      if (call.method === "PATCH") {
        const values = call.body?.properties as typeof this.properties;
        for (const value of values) {
          this.properties = this.properties.filter((property) =>
            property.property_name !== value.property_name
          );
          this.properties.push(value);
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return json(this.properties);
    }
    if (call.method === "GET") {
      if (path.endsWith("/teams")) return json(this.teams);
      if (path.includes("/git/ref/")) {
        return json({ message: "Git Repository is empty." }, 409);
      }
      if (path.endsWith("/branches")) return json([]);
      if (path.endsWith("/actions/permissions")) {
        return json({ enabled: true, allowed_actions: "all" });
      }
      if (path.endsWith("/rulesets")) return json([]);
      if (path.endsWith("/environments")) return json({ environments: [] });
      if (path.endsWith("/variables")) return json({ variables: [] });
      if (path.includes("/variables/")) {
        return json({ message: "Not Found" }, 404);
      }
      if (path.endsWith("/secrets")) return json({ secrets: [] });
    }
    if (call.method === "POST" && path.endsWith("/actions/variables")) {
      return json({}, 201);
    }
    if (call.method === "PUT" && path.endsWith("/actions/permissions")) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (call.method === "PUT" && path.includes("/environments/")) {
      return json({});
    }
    throw new Error("Unexpected request: " + call.method + " " + path);
  };

  repository() {
    return {
      name: this.name,
      full_name: "acme/" + this.name,
      html_url: "https://github.com/acme/" + this.name,
      visibility: this.visibility,
      description: null,
      homepage: null,
      default_branch: "main",
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      has_discussions: false,
      has_pull_requests: true,
      is_template: false,
      archived: false,
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      allow_auto_merge: false,
      delete_branch_on_merge: false,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      merge_commit_title: "PR_TITLE",
      merge_commit_message: "PR_BODY",
      ...this.settings,
    };
  }

  client() {
    return new FetchGitHubClient({ token: "test", fetch: this.fetch });
  }

  mutations() {
    return this.calls.filter(({ method }) => method !== "GET");
  }
}

function configuration(
  repository: RepositoryConfiguration = {},
): LoadedConfiguration {
  return {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: {
          include: {
            names: ["api-*"],
            visibility: "internal",
            teams: ["platform"],
            properties: { tier: "backend" },
          },
        },
      },
    },
    templates: {
      "repository:services": {
        version: 1,
        kind: "repository",
        match: { include: "all" },
        repository,
      },
    },
  };
}

function run(
  github: GitHub,
  loaded = configuration(),
  input: Partial<RepositoryCreationRequest> = {},
) {
  return createRepository({
    configuration: loaded,
    template: "services",
    name: "api-orders",
    ...input,
  }, {
    client: github.client(),
    randomBytes: (length) => new Uint8Array(length),
  });
}

Deno.test("creation verifies actual selectors then uses normal GitHub reconciliation and report", async () => {
  const github = new GitHub();
  const result = await run(
    github,
    configuration({
      settings: { description: "Orders", hasIssues: false },
      teams: [{ name: "platform", permission: "maintain" }],
      actions: { enabled: false, variables: [{ name: "REGION", value: "eu" }] },
      environments: [{ name: "production" }],
    }),
  );
  assertEquals(
    result.status,
    "completed",
    JSON.stringify({ result, calls: github.calls }),
  );
  assertEquals(result.completedStages, [
    "configuration",
    "preflight",
    "availability",
    "creation",
    "metadata",
    "classification",
    "reconciliation",
  ]);
  assertEquals(result.repository, {
    name: "api-orders",
    fullName: "acme/api-orders",
    url: "https://github.com/acme/api-orders",
  });
  assertEquals(github.mutations()[0], {
    method: "POST",
    path: "/orgs/acme/repos",
    body: { name: "api-orders", visibility: "internal", auto_init: false },
  });
  assertEquals(result.metadataAssignments.map(({ status }) => status), [
    "applied",
    "applied",
  ]);
  assertEquals(github.teams, [{ slug: "platform", permission: "maintain" }]);
  assertEquals(github.properties, [{
    property_name: "tier",
    value: "backend",
  }]);
  assertEquals(result.report?.repositories[0].status, "applied");
  assertEquals(
    result.report?.repositories[0].items.filter(({ status }) =>
      status === "applied"
    ).map(({ type }) => type),
    [
      "repository-settings",
      "actions-settings",
      "actions-variable",
      "team-permission",
      "environment",
    ],
  );
  const metadataWrite = github.calls.findIndex(({ path }) =>
    path.endsWith("/properties/values")
  );
  const verificationRead = github.calls.findIndex(({ path, method }, index) =>
    index > metadataWrite && method === "GET" && path.endsWith("/teams")
  );
  const settingsWrite = github.calls.findIndex(({ path, method }) =>
    method === "PATCH" && path === "/repos/acme/api-orders"
  );
  assert(verificationRead > metadataWrite && settingsWrite > verificationRead);
  assertStringIncludes(
    renderRepositoryCreationResult(result),
    result.repository!.url,
  );
  assertStringIncludes(
    renderRepositoryCreationResult(result),
    "Octosmith report for acme",
  );
});

for (
  const input of [
    { template: "missing" },
    { name: "outside-scope" },
    { visibility: "public" },
  ]
) {
  Deno.test(
    "creation rejects preflight before any API access: " +
      JSON.stringify(input),
    async () => {
      const github = new GitHub();
      const result = await run(github, configuration(), input);
      assertEquals(result.status, "preflight_rejected");
      assertEquals(github.calls, []);
      assertEquals(result.report, undefined);
    },
  );
}

Deno.test("creation unresolved visibility and unreachable selectors never initialize client", async () => {
  for (
    const scope of [
      {
        include: {
          names: ["api-*"],
          visibility: ["internal", "private"] as const,
        },
      },
      { include: { names: ["different-*"], visibility: "internal" as const } },
    ]
  ) {
    const loaded = configuration();
    const result = await createRepository({
      configuration: {
        ...loaded,
        configuration: {
          ...loaded.configuration,
          repositories: { scope },
        },
        templates: {
          "repository:services": {
            ...loaded.templates["repository:services"],
            match: { include: { names: ["api-*"] } },
          },
        },
      },
      template: "services",
    }, {
      client: () => {
        throw new Error("must not initialize");
      },
    });
    assertEquals(result.status, "preflight_rejected");
    assertEquals(result.failedStage, "preflight");
  }
});

Deno.test("generated name is resolved exactly once, including collision and remote failure", async () => {
  for (const failure of ["none", "existing", "rejected"] as const) {
    const github = new GitHub();
    github.name = "api-aaaaaa";
    github.exists = failure === "existing";
    if (failure === "rejected") {
      github.override = ({ method }) =>
        method === "POST"
          ? Response.json({ message: "Rejected" }, { status: 403 })
          : undefined;
    }
    let generations = 0;
    const result = await createRepository({
      configuration: configuration(),
      template: "services",
    }, {
      client: github.client(),
      randomBytes: (length) => {
        generations++;
        return new Uint8Array(length);
      },
    });
    assertEquals(generations, 1);
    assertEquals(result.requestedName, "api-aaaaaa");
    assertEquals(
      result.status,
      failure === "none"
        ? "completed"
        : failure === "existing"
        ? "name_collision"
        : "creation_failed",
    );
    assertEquals(
      github.mutations().filter(({ path }) => path === "/orgs/acme/repos")
        .length,
      failure === "existing" ? 0 : 1,
    );
    if (failure === "existing") assertEquals(result.repository, undefined);
  }
});

for (const status of [401, 403, 422, 500]) {
  Deno.test(`GitHub creation rejection HTTP ${status} is structured and redacts response bodies`, async () => {
    const github = new GitHub();
    github.override = ({ method }) =>
      method === "POST"
        ? Response.json({ message: "sensitive-api-body" }, { status })
        : undefined;
    const result = await run(github);
    assertEquals(result.status, "creation_failed");
    assertEquals(result.error?.httpStatus, status);
    assertEquals(result.failedStage, "creation");
    assertEquals(result.repository, undefined);
    assertEquals(result.report, undefined);
    assertEquals(JSON.stringify(result).includes("sensitive-api-body"), false);
    assertEquals(github.mutations().length, 1);
  });
}

Deno.test("a create-time name race reports collision without adoption or retry", async () => {
  const github = new GitHub();
  github.override = ({ method }) => {
    if (method === "POST") {
      github.exists = true;
      return Response.json({ message: "already exists" }, { status: 422 });
    }
  };
  const result = await run(github);
  assertEquals(result.status, "name_collision");
  assertEquals(result.repository, undefined);
  assertEquals(github.mutations().length, 1);
});

for (const target of ["team", "property"] as const) {
  Deno.test(
    "partial metadata assignment failure retains repository: " + target,
    async () => {
      const github = new GitHub();
      github.override = ({ path, method }) =>
        method !== "GET" && (
            target === "team"
              ? path.includes("/teams/")
              : path.endsWith("/properties/values")
          )
          ? Response.json({ message: "Forbidden" }, { status: 403 })
          : undefined;
      const result = await run(github);
      assertEquals(result.status, "metadata_failed");
      assertEquals(result.failedStage, "metadata");
      assertEquals(result.repository?.name, "api-orders");
      assertEquals(result.report, undefined);
      assertEquals(result.metadataAssignments.at(-1)?.status, "failed");
      assertStringIncludes(
        result.recovery!,
        "cannot discover or repair repositories outside scope",
      );
      assertEquals(
        github.mutations().some(({ method }) => method === "DELETE"),
        false,
      );
    },
  );
}

for (
  const failure of [
    "team_not_persisted",
    "property_not_persisted",
    "template_mismatch",
    "overlap",
  ] as const
) {
  Deno.test(
    "actual metadata verification stops reconciliation: " + failure,
    async () => {
      const github = new GitHub();
      const base = configuration({
        settings: { description: "must-not-apply" },
      });
      const loaded = { ...base, templates: { ...base.templates } };
      if (failure === "overlap" || failure === "template_mismatch") {
        loaded.templates["repository:other"] = {
          version: 1,
          kind: "repository",
          match: {
            include: failure === "overlap"
              ? { names: ["other-*"] }
              : { properties: { extra: "unexpected" } },
          },
          repository: {},
        };
      }
      github.override = ({ path, method }) => {
        if (failure === "overlap" && method === "POST") {
          // Defense in depth: a host can mutate its loaded configuration during an API await.
          loaded.templates["repository:other"] = {
            ...loaded.templates["repository:other"],
            match: { include: { properties: { extra: "unexpected" } } },
          };
        }
        if (method !== "GET") return;
        if (
          failure === "team_not_persisted" && path.endsWith("/teams")
        ) return Response.json([]);
        if (path.endsWith("/properties/values")) {
          if (failure === "property_not_persisted") return Response.json([]);
          if (failure === "overlap" || failure === "template_mismatch") {
            return Response.json([...github.properties, {
              property_name: "extra",
              value: "unexpected",
            }]);
          }
        }
      };
      if (failure === "template_mismatch") {
        // The selected template excludes a property unexpectedly assigned by organization policy.
        loaded.templates["repository:services"] = {
          ...loaded.templates["repository:services"],
          match: {
            include: "all",
            exclude: { properties: { extra: "unexpected" } },
          },
        };
      }
      const result = await run(github, loaded);
      assertEquals(result.status, "classification_failed");
      assertEquals(result.report, undefined);
      assertEquals(
        result.repository?.url,
        "https://github.com/acme/api-orders",
      );
      assertEquals(
        github.mutations().some(({ body }) =>
          body?.description === "must-not-apply"
        ),
        false,
      );
    },
  );
}

for (const mode of ["direct", "pull_request"] as const) {
  Deno.test(
    "creation excludes file delivery and defers branch-dependent work under " +
      mode,
    async () => {
      const github = new GitHub();
      const loaded = await loadConfigurationDirectory(
        "tests/fixtures/creation-preview",
      );
      const result = await run(github, {
        ...loaded,
        configuration: {
          ...loaded.configuration,
          repositories: {
            ...loaded.configuration.repositories,
            fileChanges: { mode },
          },
        },
      }, {
        name: "team-orders-svcs",
        visibility: "internal",
        skipMissingValues: true,
      });
      assertEquals(result.status, "awaiting_bootstrap");
      assertEquals(result.repository?.name, "team-orders-svcs");
      assert(result.deferred.some(({ resource }) => resource === "files"));
      assert(
        result.deferred.some(({ resource }) => resource === "default_branch"),
      );
      assertEquals(
        result.report?.repositories[0].items.filter(({ type }) =>
          type === "file"
        ).map(({ status }) => status),
        ["skipped", "skipped", "skipped"],
      );
      assertEquals(
        github.calls.some(({ path }) =>
          path.includes("/contents/") || path.includes("/pulls") ||
          path.includes("/git/commits") || path.includes("/git/refs") ||
          path.includes("/git/trees")
        ),
        false,
      );
      assertEquals(JSON.stringify(result).includes("README contents"), false);
    },
  );
}

Deno.test("GitHub-only planner defers rulesets and archival without mutating desired state", () => {
  const desired = {
    repository: "sample",
    template: "repository:services",
    settings: { defaultBranch: "trunk", archived: true, description: "Orders" },
    rulesets: [{
      name: "protect",
      target: "branch" as const,
      enforcement: "active" as const,
      conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [],
    }],
    files: [{
      path: "README.md",
      ensure: "exact" as const,
      content: "private file contents",
    }],
  };
  const snapshot = structuredClone(desired);
  const current = currentState({
    history: { initialized: false },
    filesBranch: "trunk",
  });
  const plan = buildPlan(current, desired, { scope: "github-only" });
  assertEquals(plan.managedFiles, undefined);
  assertEquals(plan.operations, [{
    type: "update-repository-settings",
    settings: { description: "Orders" },
  }]);
  const evaluations = buildApplyEvaluations(desired, plan.operations, current, {
    scope: "github-only",
  });
  assertEquals(
    evaluations.filter(({ details }) => details.deferred).map(({ type }) =>
      type
    ),
    ["repository-settings", "ruleset", "file"],
  );
  assertEquals(desired, snapshot);
  const resumed = buildPlan(currentState(), desired, { scope: "github-only" });
  assert(resumed.operations.some(({ type }) => type === "create-ruleset"));
  assert(
    resumed.operations.some((operation) =>
      operation.type === "update-repository-settings" &&
      operation.settings.archived
    ),
  );
  assertEquals(
    resumed.operations.some(({ type }) => type === "create-file"),
    false,
  );
  assert(
    buildPlan(current, desired).operations.some(({ type }) =>
      type === "initialize-repository"
    ),
  );
});

Deno.test("GitHub-only sink refuses accidental content operations and never runs PR finish", async () => {
  const github = new GitHub();
  const sink = new GitHubRepositoryMutationSink({
    client: github.client(),
    owner: "acme",
    secretValue: () => "unused",
    scope: "github-only",
    fileChanges: { mode: "pull_request" },
  });
  await assertRejects(
    () =>
      sink.apply("api-orders", {
        type: "initialize-repository",
        branch: "main",
      }),
    Error,
    "excluded",
  );
  await assertRejects(
    () =>
      sink.apply("api-orders", {
        type: "create-file",
        file: { path: "README.md", ensure: "exact", content: "private" },
      }),
    Error,
    "excluded",
  );
  await sink.finish("api-orders");
  assertEquals(github.calls, []);
});

Deno.test("creation recognizes empty repositories with 404 ref and empty branch listing", async () => {
  const github = new GitHub();
  github.override = ({ path }) =>
    path.includes("/git/ref/")
      ? Response.json({ message: "Not Found" }, { status: 404 })
      : undefined;
  assertEquals((await run(github)).status, "completed");
  assert(github.calls.some(({ path }) => path.endsWith("/branches")));
});

Deno.test("reconciliation partial failure keeps normal report and redacts runtime values", async () => {
  const github = new GitHub();
  github.override = ({ path, method }) =>
    method === "POST" && path.endsWith("/actions/variables")
      ? Response.json({ message: "PRIVATE-RUNTIME-VALUE" }, { status: 403 })
      : undefined;
  const result = await createRepository({
    configuration: configuration({
      settings: { description: "Applied before failure" },
      actions: { variables: [{ from: "TOKEN_SOURCE", to: "TOKEN" }] },
    }),
    template: "services",
    name: "api-orders",
  }, { client: github.client(), values: () => "PRIVATE-RUNTIME-VALUE" });
  assertEquals(result.status, "reconciliation_failed");
  assertEquals(result.report?.repositories[0].status, "partially-applied");
  assertEquals(
    result.report?.repositories[0].items.some(({ status }) =>
      status === "failed"
    ),
    true,
  );
  assertEquals(JSON.stringify(result).includes("PRIVATE-RUNTIME-VALUE"), false);
  assertEquals(
    renderRepositoryCreationResult(result).includes("PRIVATE-RUNTIME-VALUE"),
    false,
  );
  assertStringIncludes(renderRepositoryCreationResult(result), "api-orders");
});

Deno.test("creation honors missing runtime values, skip policy and manual secret policy", async () => {
  const loaded = configuration({
    actions: {
      variables: [{ from: "MISSING", to: "RUNTIME" }],
      secrets: [{ from: "SECRET_SOURCE", to: "SECRET" }],
    },
  });
  const failed = await run(new GitHub(), loaded);
  assertEquals(failed.status, "reconciliation_failed");
  assert(failed.report?.repositories[0].diagnostics?.length);
  const manual = {
    ...loaded,
    configuration: {
      ...loaded.configuration,
      repositories: {
        ...loaded.configuration.repositories,
        settings: { secrets: "manual" as const },
      },
    },
  };
  const github = new GitHub();
  const skipped = await run(github, manual, { skipMissingValues: true });
  assertEquals(skipped.status, "completed");
  assertEquals(
    github.calls.some(({ path }) => path.includes("/secrets")),
    false,
  );
  assert(
    skipped.report?.repositories[0].diagnostics?.some(({ code }) =>
      code === "skipped_variable"
    ),
  );
  const optedIn = await run(new GitHub(), manual, { includeSecrets: true });
  assertEquals(optedIn.status, "reconciliation_failed");
});

Deno.test("strict reconciliation cannot discard required selector metadata", async () => {
  const loaded = configuration({ teams: [], customProperties: {} });
  const github = new GitHub();
  const result = await run(github, {
    ...loaded,
    configuration: {
      ...loaded.configuration,
      repositories: {
        ...loaded.configuration.repositories,
        settings: { collectionManagement: "strict" },
      },
    },
  });
  assertEquals(result.status, "reconciliation_failed");
  assertStringIncludes(
    result.report!.repositories[0].error!,
    "selector-required",
  );
  assertEquals(
    github.mutations().some(({ method }) => method === "DELETE"),
    false,
  );
});

for (const enabled of [true, false]) {
  Deno.test(`creation writes boolean selector ${enabled} using GitHub string representation`, async () => {
    const loaded = configuration();
    const github = new GitHub();
    const result = await run(github, {
      ...loaded,
      configuration: {
        ...loaded.configuration,
        repositories: {
          scope: {
            include: {
              names: ["api-*"],
              visibility: "internal",
              properties: { enabled },
            },
          },
        },
      },
    });
    assertEquals(result.status, "completed");
    assertEquals(github.properties, [{
      property_name: "enabled",
      value: String(enabled),
    }]);
  });
}

for (const enabled of [true, false]) {
  Deno.test(`creation preserves boolean selector ${enabled} through planned updates and refreshed classification`, async () => {
    const base = configuration({
      customProperties: { enabled: String(enabled) },
    });
    const loaded: LoadedConfiguration = {
      ...base,
      configuration: {
        ...base.configuration,
        repositories: {
          scope: { include: { properties: { enabled } } },
        },
      },
      templates: {
        "repository:services": {
          ...base.templates["repository:services"],
          match: { include: { properties: { enabled } } },
        },
      },
    };
    const github = new GitHub();
    let propertyReads = 0;
    github.override = ({ method, path }) => {
      if (method === "GET" && path.endsWith("/properties/values")) {
        // Simulate drift after classification so normal reconciliation must restore the value.
        if (++propertyReads === 2) {
          github.properties = [];
          return Response.json([]);
        }
      }
    };

    const result = await run(github, loaded);
    assertEquals(result.status, "completed", JSON.stringify(result));
    assertEquals(result.metadataAssignments, [{
      kind: "custom_property",
      target: "enabled",
      status: "applied",
    }]);
    assertEquals(
      github.mutations().filter(({ path }) =>
        path.endsWith("/properties/values")
      ).map(({ body }) => body),
      [
        { properties: [{ property_name: "enabled", value: String(enabled) }] },
        { properties: [{ property_name: "enabled", value: String(enabled) }] },
      ],
    );
    assertEquals(result.report?.repositories[0].items, [{
      type: "custom-property",
      status: "applied",
      details: {
        name: "enabled",
        value: String(enabled),
        action: "set",
      },
    }]);

    const discovery = await discoverRepositories(
      github.client(),
      loaded,
      github.name,
    );
    assertEquals(discovery.failures, []);
    assertEquals(discovery.repositories[0].properties, {
      enabled: String(enabled),
    });
    const metadata = discovery.repositories[0];
    assertEquals(classifyResource(loaded, metadata), {
      status: "matched",
      template: "repository:services",
    });
    const desired = await resolveDesiredState(loaded, metadata, () => "");
    const current = await readCurrentState(
      new GitHubRepositoryStateSource(github.client(), "acme"),
      desired,
      undefined,
      { scope: "github-only" },
    );
    assertEquals(
      buildPlan(current, desired, { scope: "github-only" }).operations,
      [],
    );
  });
}

for (const value of ["false", "TRUE", null, ["true"]]) {
  Deno.test(`creation rejects incompatible boolean selector value ${JSON.stringify(value)}`, async () => {
    const base = configuration({ customProperties: { enabled: value } });
    const github = new GitHub();
    const result = await run(github, {
      ...base,
      configuration: {
        ...base.configuration,
        repositories: {
          scope: { include: { properties: { enabled: true } } },
        },
      },
    });
    assertEquals(result.status, "preflight_rejected");
    assertEquals(github.calls, []);
  });
}

Deno.test("creation permissions distinguish creation, selector metadata and reconciliation", () => {
  const loaded = configuration();
  const regular = requiredPermissionsForConfiguration(loaded, "services");
  const analysis = requiredPermissionsForRepositoryCreation(loaded, "services");
  assertEquals(analysis.organization, "acme");
  assertEquals(analysis.creation, [{
    scope: "repository",
    permission: "administration",
    access: "write",
  }]);
  assert(
    analysis.selectorMetadata.some(({ permission }) =>
      permission === "members"
    ),
  );
  assert(
    analysis.selectorMetadata.some(({ permission }) =>
      permission === "repository_custom_properties"
    ),
  );
  assertEquals(
    requiredPermissionsForConfiguration(loaded, "services"),
    regular,
  );
  assertEquals(
    analysis.reconciliation.some(({ permission, access }) =>
      permission === "contents" && access === "write"
    ),
    false,
  );
});

Deno.test("CLI actual creation and collision JSON remain valid with shared authentication", async () => {
  const github = new GitHub();
  const output: string[] = [];
  const errors: string[] = [];
  const args = [
    "resource",
    "create",
    "services",
    "--name",
    "team-orders-svcs",
    "--visibility",
    "internal",
    "--path",
    "tests/fixtures/creation-preview",
    "--format",
    "json",
    "--skip-missing-values",
  ];
  const options = {
    credentials: { getEnv: () => "token" },
    fetch: github.fetch,
    write: (value: string) => output.push(value),
    writeError: (value: string) => errors.push(value),
  };
  assertEquals(await main(args, options), 0);
  assertEquals(JSON.parse(output.pop()!).status, "awaiting_bootstrap");
  assertEquals(errors, []);
  assertEquals(await main(args, options), 1);
  assertEquals(JSON.parse(output.pop()!).status, "name_collision");
  assertEquals(
    github.mutations().filter(({ path }) => path === "/orgs/acme/repos").length,
    1,
  );
});

Deno.test("creation uses normal encryption for Actions, Dependabot and environment secrets", async () => {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  const github = new GitHub();
  github.override = ({ method, path }) => {
    if (method === "GET" && path.endsWith("/public-key")) {
      return Response.json({
        key_id: "key",
        key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL),
      });
    }
    if (method === "PUT" && path.includes("/secrets/")) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path.endsWith("/variables")) {
      return Response.json({}, { status: 201 });
    }
  };
  const value = "SECRET-RUNTIME-SENTINEL";
  const result = await createRepository({
    configuration: configuration({
      actions: { secrets: [{ from: "ACTION_SOURCE", to: "ACTION" }] },
      dependabot: {
        secrets: [{ from: "DEPENDABOT_SOURCE", to: "DEPENDABOT" }],
      },
      environments: [{
        name: "production",
        secrets: [{ from: "ENV_SOURCE", to: "ENV" }],
        variables: [{ name: "RUNTIME", value: "PRIVATE-VARIABLE-SENTINEL" }],
      }],
    }),
    template: "services",
    name: "api-orders",
  }, { client: github.client(), values: () => value });
  assertEquals(result.status, "completed");
  const writes = github.mutations().filter(({ body }) =>
    typeof body?.encrypted_value === "string"
  );
  assertEquals(writes.length, 3);
  for (const { body } of writes) {
    assertEquals(
      sodium.to_string(sodium.crypto_box_seal_open(
        sodium.from_base64(
          String(body!.encrypted_value),
          sodium.base64_variants.ORIGINAL,
        ),
        keys.publicKey,
        keys.privateKey,
      )),
      value,
    );
  }
  for (
    const output of [
      JSON.stringify(result),
      renderRepositoryCreationResult(result),
    ]
  ) {
    assertEquals(output.includes(value), false);
    assertEquals(output.includes("PRIVATE-VARIABLE-SENTINEL"), false);
  }
  assertEquals(
    result.report?.repositories[0].items.filter(({ type }) =>
      type === "actions-secret" || type === "dependabot-secret" ||
      type === "environment"
    ).map(({ status }) => status),
    ["applied", "applied", "applied"],
  );
});

Deno.test("creation deferral result is explicit and fresh plans resume only remaining deltas", async () => {
  const github = new GitHub();
  github.override = ({ path }) => {
    if (path.endsWith("/rulesets")) {
      throw new Error("Rulesets must not be read before bootstrap");
    }
  };
  const result = await run(
    github,
    configuration({
      settings: {
        defaultBranch: "trunk",
        archived: true,
        description: "Orders",
      },
      rulesets: [{
        name: "protect",
        target: "branch",
        enforcement: "active",
        conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [],
      }],
    }),
  );
  assertEquals(result.status, "awaiting_bootstrap");
  assertEquals(result.deferred.map(({ resource }) => resource), [
    "default_branch",
    "rulesets",
    "archival",
  ]);
  const items = result.report!.repositories[0].items;
  assertEquals(
    items.filter(({ status }) => status === "applied").map(({ type }) => type),
    ["repository-settings"],
  );
  assertEquals(
    items.filter(({ status }) => status === "skipped").map(({ type }) => type),
    ["repository-settings", "ruleset"],
  );
  const text = renderRepositoryCreationResult(result);
  assertStringIncludes(text, "until Git content bootstrap completes");
  assertEquals(text.includes("cleanup is merged"), false);
  const desired = {
    repository: "sample",
    template: "repository:services",
    settings: { defaultBranch: "trunk", description: "Orders" },
    rulesets: [{
      name: "protect",
      target: "branch" as const,
      enforcement: "active" as const,
      conditions: { refName: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [],
    }],
  };
  const resumed = buildPlan(
    currentState({
      history: { initialized: true },
      settings: {
        ...currentState().settings,
        defaultBranch: "trunk",
        description: "Orders",
      },
    }),
    desired,
    { scope: "github-only" },
  );
  assertEquals(resumed.operations.map(({ type }) => type), ["create-ruleset"]);
});

Deno.test("metadata verification permission errors retain identity and failed stage", async () => {
  const github = new GitHub();
  github.override = ({ method, path }) =>
    method === "GET" && path.endsWith("/teams")
      ? Response.json({ message: "private-body" }, { status: 403 })
      : undefined;
  const result = await run(github);
  assertEquals(result.status, "classification_failed");
  assertEquals(result.error?.httpStatus, 403);
  assertEquals(result.repository?.name, "api-orders");
  assertEquals(result.report, undefined);
  assertEquals(JSON.stringify(result).includes("private-body"), false);
});

Deno.test("creation library configuration and authentication failures have structured results", async () => {
  const github = new GitHub();
  const missing = await createRepository({
    configuration: "tests/fixtures/creation-preview/not-found",
    template: "services",
  }, { client: github.client() });
  assertEquals(missing.status, "preflight_rejected");
  assertEquals(missing.failedStage, "configuration");
  assertEquals(github.calls, []);
  const auth = await createRepository({
    configuration: configuration(),
    template: "services",
    name: "api-orders",
  }, {
    client: () => {
      throw new Error("PRIVATE-AUTH-DETAIL");
    },
  });
  assertEquals(auth.status, "creation_failed");
  assertEquals(auth.failedStage, "availability");
  assertEquals(JSON.stringify(auth).includes("PRIVATE-AUTH-DETAIL"), false);
});

Deno.test("CLI creation text and JSON preserve partial failure exit codes", async () => {
  for (const format of ["text", "json"]) {
    const github = new GitHub();
    github.override = ({ method, path }) =>
      method === "PUT" && path.includes("/teams/")
        ? Response.json({ message: "Forbidden" }, { status: 403 })
        : undefined;
    const output: string[] = [];
    const errors: string[] = [];
    assertEquals(
      await main([
        "resource",
        "create",
        "services",
        "--name",
        "team-orders-svcs",
        "--visibility",
        "internal",
        "--path",
        "tests/fixtures/creation-preview",
        "--format",
        format,
      ], {
        credentials: { getEnv: () => "token" },
        fetch: github.fetch,
        write: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      }),
      1,
    );
    const rendered = (format === "json" ? output : errors).join("\n");
    if (format === "json") {
      assertEquals(JSON.parse(rendered).status, "metadata_failed");
      assertEquals(errors, []);
    } else {
      assertStringIncludes(rendered, "metadata_failed");
      assertStringIncludes(rendered, "Metadata team platform: failed");
    }
    assertStringIncludes(rendered, "https://github.com/acme/team-orders-svcs");
  }
});

Deno.test("CLI creation configuration and credential failures keep JSON parseable", async () => {
  for (
    const path of [
      "tests/fixtures/creation-preview/not-found",
      "tests/fixtures/creation-preview",
    ]
  ) {
    const output: string[] = [];
    const errors: string[] = [];
    assertEquals(
      await main([
        "resource",
        "create",
        "services",
        "--name",
        "team-orders-svcs",
        "--visibility",
        "internal",
        "--path",
        path,
        "--format",
        "json",
      ], {
        credentials: {
          getEnv: () => {
            throw new Error("PRIVATE-CREDENTIAL-DETAIL");
          },
        },
        write: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      }),
      1,
    );
    const result = JSON.parse(output.join("\n"));
    assertEquals(result.kind, "repository_creation");
    assertEquals(
      result.failedStage,
      path.endsWith("not-found") ? "configuration" : "availability",
    );
    assertEquals(errors, []);
    assertEquals(
      JSON.stringify(result).includes("PRIVATE-CREDENTIAL-DETAIL"),
      false,
    );
  }
});

Deno.test("CLI creation permission analysis is offline and separates lifecycle authorization", async () => {
  const output: string[] = [];
  assertEquals(
    await main([
      "template",
      "permissions",
      "services",
      "--creation",
      "--format",
      "json",
      "--path",
      "tests/fixtures/creation-preview",
    ], {
      credentials: {
        getEnv: () => {
          throw new Error("must stay offline");
        },
      },
      write: (value) => output.push(value),
    }),
    0,
  );
  const result = JSON.parse(output.join("\n"));
  assertEquals(result.organization, "acme");
  assertEquals(result.creation[0].permission, "administration");
  assert(result.selectorMetadata.length > 0);
  assert(result.reconciliation.length > 0);
});
