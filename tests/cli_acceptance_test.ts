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

function fakeGitHub(
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
      return json(repository());
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

function repository(): Record<string, unknown> {
  return {
    name: "sample",
    description: null,
    homepage: null,
    topics: [],
    visibility: "private",
    has_issues: true,
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
