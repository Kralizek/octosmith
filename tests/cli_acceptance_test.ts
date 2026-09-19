import { assertEquals, assertStringIncludes } from "@std/assert";
import { createGitHubRuntime, main } from "../packages/cli/mod.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body?: unknown;
}

Deno.test("CLI reconciles through the real GitHub HTTP stack", async () => {
  const root = await configurationDirectory();
  const strictRoot = await configurationDirectory(false, "strict");
  const previous = Deno.env.get("DESIRED");

  try {
    Deno.env.set("DESIRED", "same");

    const requests: CapturedRequest[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });
    const output: string[] = [];

    assertEquals(
      await main(
        ["plan", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      0,
    );
    assertEquals(mutations(requests), []);
    assertStringIncludes(output.join("\n"), "sample");

    requests.length = 0;
    output.length = 0;

    assertEquals(
      await main(
        ["apply", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      0,
    );
    assertEquals(
      mutations(requests).map((request) => [
        request.method,
        request.url.pathname,
        request.body,
      ]),
      [[
        "PATCH",
        "/api/v3/repos/acme/sample",
        { has_issues: false },
      ]],
    );

    requests.length = 0;
    output.length = 0;

    assertEquals(
      await main(
        ["apply", "--path", strictRoot],
        { runtime, write: (value) => output.push(value) },
      ),
      0,
    );
    assertEquals(
      mutations(requests).map((request) => [
        request.method,
        request.url.pathname,
        request.body,
      ]),
      [
        [
          "PATCH",
          "/api/v3/repos/acme/sample",
          { has_issues: false },
        ],
        [
          "DELETE",
          "/api/v3/repos/acme/sample/actions/variables/EXTRA",
          undefined,
        ],
      ],
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DESIRED");
    } else {
      Deno.env.set("DESIRED", previous);
    }

    await Deno.remove(root, { recursive: true });
    await Deno.remove(strictRoot, { recursive: true });
  }
});

Deno.test("CLI targets one in-scope repository without enumerating the organization", async () => {
  const root = await configurationDirectory();
  const previous = Deno.env.get("DESIRED");

  try {
    Deno.env.set("DESIRED", "same");

    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });

    assertEquals(
      await main(
        ["plan", "sample", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      0,
    );

    assertEquals(
      requests.some((request) =>
        request.url.pathname === "/api/v3/orgs/acme/repos"
      ),
      false,
    );
    assertEquals(mutations(requests), []);
    const rendered = output.join("\n");
    assertStringIncludes(rendered, "sample [code] — planned");
    assertStringIncludes(
      rendered,
      "Summary: 0 unchanged, 1 planned, 0 applied, 0 partially-applied, 0 failed",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DESIRED");
    } else {
      Deno.env.set("DESIRED", previous);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI rejects an explicitly empty repository target without discovery", async () => {
  const root = await configurationDirectory();
  const requests: CapturedRequest[] = [];
  const errors: string[] = [];
  const originalError = console.error;

  try {
    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });

    assertEquals(
      await main(
        ["apply", "", "--path", root],
        { runtime },
      ),
      1,
    );

    assertEquals(requests, []);
    assertStringIncludes(
      errors.join("\n"),
      "Repository target must not be empty",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI rejects an explicitly empty repository target after options", async () => {
  const root = await configurationDirectory();
  const requests: CapturedRequest[] = [];
  const errors: string[] = [];
  const originalError = console.error;

  try {
    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });

    assertEquals(
      await main(
        ["apply", "--path", root, ""],
        { runtime },
      ),
      1,
    );

    assertEquals(requests, []);
    assertStringIncludes(
      errors.join("\n"),
      "Repository target must not be empty",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI reports an out-of-scope targeted repository without mutation", async () => {
  const root = await configurationDirectory(true);
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  try {
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });

    assertEquals(
      await main(
        ["apply", "outside", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      1,
    );

    assertEquals(mutations(requests), []);
    assertEquals(
      requests.map((request) => request.url.pathname),
      ["/api/v3/repos/acme/outside"],
    );
    const rendered = output.join("\n");
    assertStringIncludes(rendered, "outside — failed");
    assertStringIncludes(
      rendered,
      "Repository outside is outside the configured scope",
    );
    assertStringIncludes(
      rendered,
      "Summary: 0 unchanged, 0 planned, 0 applied, 0 partially-applied, 1 failed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI isolates exact-name discovery failures", async () => {
  const root = await configurationDirectory(true);
  const previous = Deno.env.get("DESIRED");

  try {
    Deno.env.set("DESIRED", "same");

    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });

    assertEquals(
      await main(
        ["plan", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      1,
    );

    const rendered = output.join("\n");
    assertStringIncludes(rendered, "missing — failed");
    assertStringIncludes(rendered, "sample [code] — planned");
    assertEquals(mutations(requests), []);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DESIRED");
    } else {
      Deno.env.set("DESIRED", previous);
    }

    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI apply replans from fresh GitHub state", async () => {
  const root = await configurationDirectory();
  const previous = Deno.env.get("DESIRED");
  const state = { hasIssues: true };

  try {
    Deno.env.set("DESIRED", "same");

    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests, state),
    });

    assertEquals(
      await main(
        ["plan", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      0,
    );
    assertStringIncludes(output.join("\n"), "sample [code] — planned");
    assertEquals(mutations(requests), []);

    state.hasIssues = false;
    requests.length = 0;
    output.length = 0;

    assertEquals(
      await main(
        ["apply", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      0,
    );
    assertEquals(mutations(requests), []);
    assertStringIncludes(output.join("\n"), "sample [code] — unchanged");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DESIRED");
    } else {
      Deno.env.set("DESIRED", previous);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("missing repository variable value fails before mutation", async () => {
  const root = await configurationDirectory();
  const previous = Deno.env.get("DESIRED");

  try {
    Deno.env.delete("DESIRED");

    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeGitHub(requests),
    });

    assertEquals(
      await main(
        ["apply", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      1,
    );
    assertStringIncludes(
      output.join("\n"),
      "Missing environment value: DESIRED",
    );
    assertEquals(mutations(requests), []);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DESIRED");
    } else {
      Deno.env.set("DESIRED", previous);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("missing repository secret value fails before secret mutation", async () => {
  const root = await secretConfigurationDirectory();
  const previous = Deno.env.get("TOKEN");

  try {
    Deno.env.delete("TOKEN");

    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakeSecretGitHub(requests),
    });

    assertEquals(
      await main(
        ["apply", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      1,
    );
    assertStringIncludes(output.join("\n"), "Missing environment value: TOKEN");
    assertEquals(mutations(requests), []);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("TOKEN");
    } else {
      Deno.env.set("TOKEN", previous);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("partial apply skips later operations and continues with the next repository", async () => {
  const root = await partialConfigurationDirectory();
  const previous = Deno.env.get("DESIRED");

  try {
    Deno.env.set("DESIRED", "new");

    const requests: CapturedRequest[] = [];
    const output: string[] = [];
    const runtime = createGitHubRuntime({
      token: "test-token",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakePartialGitHub(requests),
    });

    assertEquals(
      await main(
        ["apply", "--path", root],
        { runtime, write: (value) => output.push(value) },
      ),
      1,
    );

    const rendered = output.join("\n");
    assertStringIncludes(rendered, "sample [code] — partially-applied");
    assertStringIncludes(rendered, "update-repository-settings — applied");
    assertStringIncludes(rendered, "set-actions-variable — failed");
    assertStringIncludes(rendered, "create-file — skipped");
    assertStringIncludes(rendered, "z-next [code] — applied");
    assertStringIncludes(
      rendered,
      "Summary: 0 unchanged, 0 planned, 1 applied, 1 partially-applied, 0 failed",
    );

    assertEquals(
      requests.some((request) =>
        request.method === "PUT" &&
        request.url.pathname ===
          "/api/v3/repos/acme/sample/contents/managed.txt"
      ),
      false,
    );
    const failedIndex = requests.findIndex((request) =>
      request.method === "PATCH" &&
      request.url.pathname ===
        "/api/v3/repos/acme/sample/actions/variables/DESIRED"
    );
    const continuedIndex = requests.findIndex((request) =>
      request.method === "PATCH" &&
      request.url.pathname === "/api/v3/repos/acme/z-next"
    );

    assertEquals(failedIndex >= 0, true);
    assertEquals(continuedIndex > failedIndex, true);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DESIRED");
    } else {
      Deno.env.set("DESIRED", previous);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI rejects a misspelled scope before any GitHub request", async () => {
  const root = await safetyConfigurationDirectory({
    code: {
      match: { names: ["*"] },
      repository: { settings: { has_issues: false } },
    },
  }, { nmaes: ["sample"] });
  const requests: CapturedRequest[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  try {
    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));
    const runtime = createGitHubRuntime({
      token: "fake",
      fetch: fakeGitHub(requests),
    });
    assertEquals(await main(["apply", "--path", root], { runtime }), 1);
    assertEquals(requests, []);
    assertStringIncludes(errors.join("\n"), "nmaes");
    assertStringIncludes(errors.join("\n"), "octosmith.yml");
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI validates all templates before plan discovery", async () => {
  const root = await safetyConfigurationDirectory({
    valid: { match: { names: ["sample"] } },
    invalid: { match: { nmaes: ["unrelated"] } },
  });
  const requests: CapturedRequest[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  try {
    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));
    const runtime = createGitHubRuntime({
      token: "fake",
      fetch: fakeGitHub(requests),
    });
    assertEquals(await main(["plan", "--path", root], { runtime }), 1);
    assertEquals(requests, []);
    assertStringIncludes(errors.join("\n"), "invalid.yml");
    assertStringIncludes(errors.join("\n"), "nmaes");
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI preflights repository secrets before strict cleanup and continues afterward", async () => {
  const root = await safetyConfigurationDirectory(
    {
      code: {
        match: { names: ["sample"] },
        repository: {
          settings: { has_issues: false },
          actions: { secrets: ["NEW"] },
        },
      },
      healthy: {
        match: { names: ["z-next"] },
        repository: { settings: { has_issues: false } },
      },
    },
    { names: ["*"] },
    "strict",
  );
  const requests: CapturedRequest[] = [];
  const events: string[] = [];
  const output: string[] = [];
  try {
    const runtime = createGitHubRuntime({
      token: "fake",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakePreflightGitHub(requests, events),
      secretValue: (name) => {
        events.push("preflight:" + name);
        throw new Error("Missing environment value: " + name);
      },
    });
    assertEquals(
      await main(["apply", "--path", root], {
        runtime,
        write: (value) => output.push(value),
      }),
      1,
    );
    assertEquals(
      mutations(requests).map((request) =>
        request.method + " " + request.url.pathname
      ),
      ["PATCH /api/v3/repos/acme/z-next"],
    );
    const preflightIndex = events.indexOf("preflight:NEW");
    assertEquals(preflightIndex >= 0, true);
    assertEquals(
      events.indexOf("PATCH /api/v3/repos/acme/z-next") > preflightIndex,
      true,
    );
    assertStringIncludes(output.join("\n"), "Missing environment value: NEW");
    assertStringIncludes(
      output.join("\n"),
      "Summary: 0 unchanged, 0 planned, 1 applied, 0 partially-applied, 1 failed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI preflights environment secrets before any strict mutation", async () => {
  const root = await safetyConfigurationDirectory(
    {
      code: {
        match: { names: ["sample"] },
        repository: { settings: { has_issues: false } },
        environments: [{
          name: "production",
          secrets: ["NEW"],
          variables: [],
        }],
      },
    },
    { names: ["sample"] },
    "strict",
  );
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  try {
    const runtime = createGitHubRuntime({
      token: "fake",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakePreflightGitHub(requests, []),
      secretValue: (name) => {
        throw new Error("Missing environment value: " + name);
      },
    });
    assertEquals(
      await main(["apply", "--path", root], {
        runtime,
        write: (value) => output.push(value),
      }),
      1,
    );
    assertEquals(mutations(requests), []);
    assertStringIncludes(output.join("\n"), "Missing environment value: NEW");
    assertStringIncludes(
      output.join("\n"),
      "Summary: 0 unchanged, 0 planned, 0 applied, 0 partially-applied, 1 failed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI plan identifies strict deletion targets and changed settings", async () => {
  const root = await safetyConfigurationDirectory(
    {
      code: {
        match: { names: ["sample"] },
        repository: {
          settings: { has_issues: false },
          actions: { secrets: ["NEW"] },
        },
        environments: [],
      },
    },
    { names: ["sample"] },
    "strict",
  );
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  let secretCalls = 0;
  try {
    const runtime = createGitHubRuntime({
      token: "fake",
      baseUrl: "https://github.example.test/api/v3",
      fetch: fakePreflightGitHub(requests, []),
      secretValue: () => {
        secretCalls++;
        return "never-display-this-value";
      },
    });
    assertEquals(
      await main(["plan", "--path", root], {
        runtime,
        write: (value) => output.push(value),
      }),
      0,
    );
    assertEquals(mutations(requests), []);
    assertEquals(secretCalls, 0);
    const rendered = output.join("\n");
    for (
      const detail of [
        '"hasIssues":false',
        '"name":"OLD"',
        '"name":"NEW"',
        '"name":"production"',
        '"name":"obsolete"',
      ]
    ) {
      assertStringIncludes(rendered, detail);
    }
    assertEquals(rendered.includes("never-display-this-value"), false);
    assertEquals(rendered.includes("private-variable-value"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function safetyConfigurationDirectory(
  templates: Readonly<Record<string, unknown>>,
  scope: unknown = { names: ["*"] },
  collections?: "strict",
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await Deno.writeTextFile(
    root + "/octosmith.yml",
    JSON.stringify({
      version: 1,
      organization: "acme",
      repositories: {
        scope,
        ...(collections && {
          settings: { collection_management: collections },
        }),
      },
    }),
  );
  for (const [name, template] of Object.entries(templates)) {
    const value = template as Record<string, unknown>;
    const repository = {
      ...((value.repository as Record<string, unknown> | undefined) ?? {}),
      ...(value.rulesets !== undefined && { rulesets: value.rulesets }),
      ...(value.environments !== undefined && {
        environments: value.environments,
      }),
      ...(value.files !== undefined && { files: value.files }),
    };
    await Deno.writeTextFile(
      root + "/templates/" + name + ".yml",
      JSON.stringify({
        kind: "repository",
        match: value.match,
        repository,
      }),
    );
  }
  return root;
}

function fakePreflightGitHub(
  requests: CapturedRequest[],
  events: string[],
): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    events.push(method + " " + url.pathname);
    if (method !== "GET") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === "/api/v3/orgs/acme/repos") {
      return Promise.resolve(
        json([{ name: "sample", visibility: "private" }, {
          name: "z-next",
          visibility: "private",
        }]),
      );
    }
    for (const name of ["sample", "z-next"]) {
      if (url.pathname === "/api/v3/repos/acme/" + name) {
        return Promise.resolve(json(repository(name)));
      }
    }
    if (url.pathname.endsWith("/secrets")) {
      return Promise.resolve(json({ secrets: [{ name: "OLD" }] }));
    }
    if (url.pathname.endsWith("/variables")) {
      return Promise.resolve(
        json({
          variables: [{
            name: "OLD_VARIABLE",
            value: "private-variable-value",
          }],
        }),
      );
    }
    if (url.pathname.endsWith("/environments")) {
      return Promise.resolve(
        json({ environments: [{ name: "production" }, { name: "obsolete" }] }),
      );
    }
    return Promise.resolve(
      json({ message: "Unexpected request: " + url.pathname }, 500),
    );
  };
}

function fakeGitHub(
  requests: CapturedRequest[],
  state: { hasIssues: boolean } = { hasIssues: true },
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const rawBody = init?.body ??
      (request ? await request.clone().text() : undefined);
    const body = typeof rawBody === "string" && rawBody.length > 0
      ? JSON.parse(rawBody)
      : undefined;

    requests.push({ method, url, body });

    if (
      method === "GET" &&
      url.pathname === "/api/v3/orgs/acme/repos"
    ) {
      return json([{
        name: "sample",
        visibility: "private",
      }]);
    }

    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/sample"
    ) {
      return json(repository("sample", state.hasIssues));
    }

    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/missing"
    ) {
      return json({ message: "Not Found" }, 404);
    }

    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/outside"
    ) {
      return json(repository("outside", state.hasIssues));
    }

    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/sample/actions/variables"
    ) {
      return json({
        variables: [
          { name: "DESIRED", value: "same" },
          { name: "EXTRA", value: "keep-unless-strict" },
        ],
      });
    }

    if (
      method === "PATCH" &&
      url.pathname === "/api/v3/repos/acme/sample"
    ) {
      return json({});
    }

    if (
      method === "DELETE" &&
      url.pathname === "/api/v3/repos/acme/sample/actions/variables/EXTRA"
    ) {
      return new Response(null, { status: 204 });
    }

    return json(
      { message: "Unexpected request: " + method + " " + url },
      500,
    );
  };
}

function mutations(
  requests: readonly CapturedRequest[],
): readonly CapturedRequest[] {
  return requests.filter((request) => request.method !== "GET");
}

function repository(
  name = "sample",
  hasIssues = true,
): Record<string, unknown> {
  return {
    name,
    description: null,
    homepage: null,
    topics: [],
    visibility: "private",
    has_issues: hasIssues,
    has_projects: false,
    has_wiki: false,
    has_discussions: false,
    has_pull_requests: true,
    pull_request_creation_policy: "all",
    is_template: false,
    default_branch: "master",
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    allow_update_branch: false,
    delete_branch_on_merge: false,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "PR_BODY",
    merge_commit_title: "PR_TITLE",
    merge_commit_message: "PR_BODY",
    archived: false,
    allow_forking: false,
    web_commit_signoff_required: false,
    security_and_analysis: {},
  };
}

async function configurationDirectory(
  exactNames = false,
  collections?: "strict",
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");

  await Deno.writeTextFile(
    root + "/octosmith.yml",
    exactNames
      ? [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        "    names:",
        "      - sample",
        "      - missing",
        "",
      ].join("\n")
      : [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        '    names: ["*"]',
        ...(collections
          ? [
            "  settings:",
            "    collection_management: " + collections,
          ]
          : []),
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
      "repository:",
      "  settings:",
      "    has_issues: false",
      "  actions:",
      "    variables:",
      "      - DESIRED",
      "",
    ].join("\n"),
  );

  return root;
}

function fakeSecretGitHub(
  requests: CapturedRequest[],
): typeof globalThis.fetch {
  return (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    requests.push({ method, url });

    if (method === "GET" && url.pathname === "/api/v3/orgs/acme/repos") {
      return Promise.resolve(
        json([{ name: "sample", visibility: "private" }]),
      );
    }
    if (method === "GET" && url.pathname === "/api/v3/repos/acme/sample") {
      return Promise.resolve(json(repository()));
    }
    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/sample/actions/secrets"
    ) {
      return Promise.resolve(json({ secrets: [] }));
    }
    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/sample/actions/secrets/public-key"
    ) {
      return Promise.resolve(json({ key_id: "key-1", key: "unused" }));
    }

    return Promise.resolve(json({ message: "Unexpected request" }, 500));
  };
}

function fakePartialGitHub(
  requests: CapturedRequest[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const rawBody = init?.body ??
      (request ? await request.clone().text() : undefined);
    const body = typeof rawBody === "string" && rawBody.length > 0
      ? JSON.parse(rawBody)
      : undefined;
    requests.push({ method, url, body });

    if (method === "GET" && url.pathname === "/api/v3/orgs/acme/repos") {
      return json([
        { name: "sample", visibility: "private" },
        { name: "z-next", visibility: "private" },
      ]);
    }

    for (const name of ["sample", "z-next"]) {
      if (method === "GET" && url.pathname === `/api/v3/repos/acme/${name}`) {
        return json(repository(name));
      }
      if (
        method === "GET" &&
        url.pathname === `/api/v3/repos/acme/${name}/actions/variables`
      ) {
        return json({
          variables: [{
            name: "DESIRED",
            value: name === "sample" ? "old" : "new",
          }],
        });
      }
      if (
        method === "GET" &&
        url.pathname ===
          `/api/v3/repos/acme/${name}/actions/variables/DESIRED`
      ) {
        return json({
          name: "DESIRED",
          value: name === "sample" ? "old" : "new",
        });
      }
      if (
        method === "GET" &&
        url.pathname === `/api/v3/repos/acme/${name}/contents/managed.txt`
      ) {
        if (name === "sample") {
          return json({ message: "Not Found" }, 404);
        }
        return json({
          type: "file",
          encoding: "base64",
          content: btoa("seed"),
          sha: "existing-sha",
        });
      }
      if (method === "PATCH" && url.pathname === `/api/v3/repos/acme/${name}`) {
        return json({});
      }
      if (
        method === "PATCH" &&
        url.pathname ===
          `/api/v3/repos/acme/${name}/actions/variables/DESIRED`
      ) {
        return name === "sample" ? json({ message: "boom" }, 500) : json({});
      }
    }

    return json(
      { message: "Unexpected request: " + method + " " + url.pathname },
      500,
    );
  };
}

async function secretConfigurationDirectory(): Promise<string> {
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
      "repository:",
      "  actions:",
      "    secrets:",
      "      - TOKEN",
      "",
    ].join("\n"),
  );
  return root;
}

async function partialConfigurationDirectory(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await Deno.mkdir(root + "/files");
  await Deno.writeTextFile(
    root + "/octosmith.yml",
    [
      "version: 1",
      "organization: acme",
      'repositories: { scope: { names: ["*"] } }',
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(root + "/files/managed.txt", "seed");
  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "kind: repository",
      "match:",
      "  names:",
      "    - sample",
      "    - z-next",
      "repository:",
      "  settings:",
      "    has_issues: false",
      "  actions:",
      "    variables:",
      "      - DESIRED",
      "  files:",
      "    managed.txt:",
      "      ensure: exact",
      "      source: files/managed.txt",
      "",
    ].join("\n"),
  );
  return root;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
