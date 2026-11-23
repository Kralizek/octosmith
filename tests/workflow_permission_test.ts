import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  describeWorkflowWriteFailure,
  FetchGitHubClient,
  type GitHubClient,
  type GitHubCredentialSource,
  GitHubRepositoryMutationSink,
  GitHubRequestError,
  type GitHubRequestOptions,
  workflowPermissionRemediation,
} from "@octosmith/octosmith";

const WORKFLOW = ".github/workflows/ci.yml";

function requestError(
  status: number,
  body: string,
  scopes?: readonly string[],
  method: string | undefined = "POST",
): GitHubRequestError {
  return new GitHubRequestError(status, "Status", body, scopes, method);
}

Deno.test("workflow remediation only names gh auth refresh for GitHub CLI credentials", () => {
  const sources: (GitHubCredentialSource | undefined)[] = [
    undefined,
    "explicit",
    "environment",
    "gh",
  ];
  for (const source of sources) {
    const text = workflowPermissionRemediation(source);
    assert(text.includes("`workflow` scope"), text);
    assert(text.includes("Workflows: write"), text);
    assertEquals(text.includes("gh auth refresh"), source === "gh", text);
  }
  assert(workflowPermissionRemediation("environment").includes("GITHUB_TOKEN"));
  assert(
    workflowPermissionRemediation("explicit").includes("explicitly supplied"),
  );
});

Deno.test("explicit GitHub refusals are confirmed regardless of status", () => {
  for (const status of [403, 422]) {
    const text = describeWorkflowWriteFailure(
      requestError(
        status,
        JSON.stringify({
          message:
            "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission",
        }),
      ),
      [WORKFLOW],
    );
    assert(text?.includes("GitHub refused the workflow-file change"), text);
    assert(text?.includes("HTTP " + status), text);
  }
});

Deno.test("404 workflow writes are attributed only as far as the evidence allows", () => {
  const scoped = describeWorkflowWriteFailure(
    requestError(404, '{"message":"Not Found"}', ["repo", "read:org"]),
    ["README.md", WORKFLOW],
    "explicit",
  );
  assert(scoped?.includes("OAuth scopes do not include `workflow`"), scoped);
  assert(scoped?.includes(WORKFLOW), scoped);
  assert(!scoped?.includes("README.md"), scoped);
  assert(!scoped?.includes('Not Found"'), scoped);

  const unknown = describeWorkflowWriteFailure(
    requestError(404, '{"message":"Not Found"}'),
    [WORKFLOW],
  );
  assert(unknown?.includes("does not confirm the cause"), unknown);
  assert(!unknown?.includes("OAuth scopes"), unknown);
});

Deno.test("unrelated failures are not classified as workflow permission", () => {
  const cases: [unknown, readonly string[]][] = [
    [requestError(404, "{}", ["repo"], "GET"), [WORKFLOW]],
    [new GitHubRequestError(404, "Not Found", "{}", ["repo"]), [WORKFLOW]],
    [requestError(404, "{}", ["repo", "workflow"]), [WORKFLOW]],
    [requestError(404, "{}", ["repo"]), ["README.md", ".github/CODEOWNERS"]],
    [
      requestError(403, '{"message":"Resource not accessible by integration"}'),
      [WORKFLOW],
    ],
    [requestError(403, '{"message":"API rate limit exceeded"}'), [WORKFLOW]],
    [
      requestError(
        403,
        '{"message":"Resource protected by organization SAML enforcement."}',
      ),
      [WORKFLOW],
    ],
    [requestError(401, '{"message":"Bad credentials"}'), [WORKFLOW]],
    [new Error("refusing to allow an OAuth App to create or update workflow"), [
      WORKFLOW,
    ]],
  ];
  for (const [error, paths] of cases) {
    assertEquals(describeWorkflowWriteFailure(error, paths), undefined);
  }
});

Deno.test("FetchGitHubClient records request method and reported OAuth scopes", async () => {
  for (
    const [header, expected] of [
      ["repo, read:org", ["repo", "read:org"]],
      ["", undefined],
      [undefined, undefined],
    ] as const
  ) {
    const client = new FetchGitHubClient({
      token: "token-must-not-leak",
      fetch: () =>
        Promise.resolve(
          new Response('{"message":"Not Found"}', {
            status: 404,
            statusText: "Not Found",
            headers: header === undefined ? {} : { "x-oauth-scopes": header },
          }),
        ),
    });
    const error = await assertRejects(
      () =>
        client.request("POST", "/repos/acme/sample/git/trees", { body: {} }),
      GitHubRequestError,
    );
    assertEquals(error.method, "POST");
    assertEquals(error.oauthScopes, expected);
    assert(!error.message.includes("token-must-not-leak"));
  }
});

class DirectFileClient implements GitHubClient {
  readonly requests: string[] = [];

  constructor(readonly treeError: GitHubRequestError) {}

  request<T>(
    method: string,
    path: string,
    _options: GitHubRequestOptions = {},
  ): Promise<T> {
    this.requests.push(method + " " + path);
    if (method === "GET" && path.includes("/contents/")) {
      return Promise.resolve(undefined as T);
    }
    if (method === "GET") return this.get(path);
    if (path.endsWith("/git/blobs")) {
      return Promise.resolve({ sha: "blob-sha" } as T);
    }
    if (path.endsWith("/git/trees")) return Promise.reject(this.treeError);
    return Promise.resolve(undefined as T);
  }

  get<T>(path: string): Promise<T> {
    if (path === "/repos/acme/sample") {
      return Promise.resolve({ default_branch: "main" } as T);
    }
    if (path.endsWith("/git/ref/heads/main")) {
      return Promise.resolve({ object: { sha: "base-sha" } } as T);
    }
    if (path.endsWith("/git/commits/base-sha")) {
      return Promise.resolve({ tree: { sha: "base-tree-sha" } } as T);
    }
    throw new Error("Unexpected GET " + path);
  }
}

function createFile(path: string) {
  return {
    type: "create-file" as const,
    file: { path, ensure: "exact" as const, content: "on: push" },
  };
}

Deno.test("direct delivery explains workflow-scope 404s with the configured credential source", async () => {
  const client = new DirectFileClient(
    requestError(404, '{"message":"Not Found","x":"body-must-not-leak"}', [
      "repo",
    ]),
  );
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
    credentialSource: "environment",
  });
  const error = await assertRejects(
    () => sink.apply("sample", createFile(WORKFLOW)),
    Error,
    "OAuth scopes do not include `workflow`",
  );
  assert(error.message.includes(WORKFLOW), error.message);
  assert(error.message.includes("GITHUB_TOKEN"), error.message);
  assert(!error.message.includes("gh auth refresh"), error.message);
  assert(!error.message.includes("body-must-not-leak"), error.message);
  assert(
    !client.requests.some((request) => request.endsWith("/git/commits")),
  );
});

Deno.test("direct delivery leaves non-workflow failures unchanged", async () => {
  const original = requestError(404, "{}", ["repo"]);
  const sink = new GitHubRepositoryMutationSink({
    client: new DirectFileClient(original),
    owner: "acme",
    secretValue: () => "unused",
    credentialSource: "gh",
  });
  const error = await assertRejects(
    () => sink.apply("sample", createFile("README.md")),
  );
  assertEquals(error, original);
});
