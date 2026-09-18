import { assertEquals, assertStringIncludes } from "@std/assert";
import { createGitHubRuntime, main } from "../packages/cli/mod.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body?: unknown;
}

Deno.test("CLI reconciles through the real GitHub HTTP stack", async () => {
  const root = await configurationDirectory();
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
        ["apply", "--path", root, "--collections", "strict"],
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
    assertStringIncludes(rendered, "set-repository-variable — failed");
    assertStringIncludes(rendered, "create-file — skipped");
    assertStringIncludes(rendered, "next [code] — applied");

    assertEquals(
      requests.some((request) =>
        request.method === "PUT" &&
        request.url.pathname ===
          "/api/v3/repos/acme/sample/contents/managed.txt"
      ),
      false,
    );
    assertEquals(
      requests.some((request) =>
        request.method === "PATCH" &&
        request.url.pathname === "/api/v3/repos/acme/next"
      ),
      true,
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
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");

  await Deno.writeTextFile(
    root + "/octosmith.yml",
    exactNames
      ? [
        "version: 1",
        "organization: acme",
        "scope:",
        "  names:",
        "    - sample",
        "    - missing",
        "",
      ].join("\n")
      : [
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
      "repository:",
      "  settings:",
      "    has_issues: false",
      "  variables:",
      "    - DESIRED",
      "",
    ].join("\n"),
  );

  return root;
}

function fakeSecretGitHub(
  requests: CapturedRequest[],
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    requests.push({ method, url });

    if (method === "GET" && url.pathname === "/api/v3/orgs/acme/repos") {
      return json([{ name: "sample", visibility: "private" }]);
    }
    if (method === "GET" && url.pathname === "/api/v3/repos/acme/sample") {
      return json(repository());
    }
    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/sample/actions/secrets"
    ) {
      return json({ secrets: [] });
    }
    if (
      method === "GET" &&
      url.pathname === "/api/v3/repos/acme/sample/actions/secrets/public-key"
    ) {
      return json({ key_id: "key-1", key: "unused" });
    }

    return json({ message: "Unexpected request" }, 500);
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
        { name: "next", visibility: "private" },
      ]);
    }

    for (const name of ["sample", "next"]) {
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
      "repository:",
      "  secrets:",
      "    - TOKEN",
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
      "scope: {}",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(root + "/files/managed.txt", "seed");
  await Deno.writeTextFile(
    root + "/templates/code.yml",
    [
      "match:",
      "  names:",
      "    - sample",
      "    - next",
      "repository:",
      "  settings:",
      "    has_issues: false",
      "  variables:",
      "    - DESIRED",
      "files:",
      "  managed.txt:",
      "    ensure: exact",
      "    source: files/managed.txt",
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
