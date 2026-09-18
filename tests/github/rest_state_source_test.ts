import { assertEquals } from "@std/assert";
import {
  type GitHubClient,
  type GitHubQueryValue,
  GitHubRepositoryStateSource,
} from "@octosmith/github";

class PagingClient implements GitHubClient {
  readonly requests: string[] = [];

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    if (method !== "GET") {
      throw new Error("Unexpected method: " + method);
    }

    return this.get(path, options.query);
  }

  get<T>(
    path: string,
    query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    const page = Number(query.page ?? 1);
    this.requests.push(path + "?page=" + page);

    if (path === "/repos/acme/sample/teams") {
      const count = page === 1 ? 100 : 1;
      return Promise.resolve(
        Array.from({ length: count }, (_, index) => ({
          slug: "team-" + ((page - 1) * 100 + index),
          permission: "pull",
        })) as T,
      );
    }

    if (path === "/repos/acme/sample/actions/variables") {
      const count = page === 1 ? 100 : 1;
      return Promise.resolve({
        variables: Array.from({ length: count }, (_, index) => ({
          name: "VAR_" + ((page - 1) * 100 + index),
          value: String((page - 1) * 100 + index),
        })),
      } as T);
    }

    throw new Error("Unexpected request: " + path);
  }
}

Deno.test("state source paginates array and wrapped collections", async () => {
  const client = new PagingClient();
  const source = new GitHubRepositoryStateSource(client, "acme");

  const [teams, variables] = await Promise.all([
    source.getTeams("sample"),
    source.getVariables("sample"),
  ]);

  assertEquals(teams.length, 101);
  assertEquals(teams[100].team, "team-100");
  assertEquals(variables.length, 101);
  assertEquals(variables[100], { name: "VAR_100", value: "100" });
  assertEquals(client.requests.sort(), [
    "/repos/acme/sample/actions/variables?page=1",
    "/repos/acme/sample/actions/variables?page=2",
    "/repos/acme/sample/teams?page=1",
    "/repos/acme/sample/teams?page=2",
  ]);
});

class MappingStateClient implements GitHubClient {
  request<T>(
    method: string,
    path: string,
    _options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    if (method !== "GET") {
      throw new Error("Unexpected method: " + method);
    }

    if (path.endsWith("/actions/oidc/customization/sub")) {
      return Promise.resolve({
        use_default: false,
        use_immutable_subject: true,
      } as T);
    }

    return this.get(path);
  }

  get<T>(
    path: string,
    _query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    if (path.endsWith("/actions/permissions")) {
      return Promise.resolve({
        enabled: true,
        allowed_actions: "all",
        sha_pinning_required: false,
      } as T);
    }

    if (path.endsWith("/rulesets")) {
      return Promise.resolve([{
        id: 1,
        source_type: "Repository",
      }] as T);
    }

    if (path.endsWith("/rulesets/1")) {
      return Promise.resolve({
        id: 1,
        name: "protect",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: ["~DEFAULT_BRANCH"],
            exclude: [],
          },
        },
        rules: [
          {
            type: "branch_name_pattern",
            parameters: {
              operator: "starts_with",
              pattern: "pull-request",
            },
          },
          {
            type: "pull_request",
            parameters: {
              allowed_merge_methods: ["squash"],
              dismiss_stale_reviews_on_push: true,
              dismissal_restriction: {
                enabled: true,
                allowed_actors: [{
                  id: 42,
                  type: "IntegrationInstallation",
                }],
              },
              require_code_owner_review: true,
              require_last_push_approval: true,
              required_approving_review_count: 1,
              required_review_thread_resolution: true,
              required_reviewers: [],
            },
          },
        ],
      } as T);
    }

    throw new Error("Unexpected GET " + path);
  }
}

Deno.test("state source distinguishes organization OIDC templates", async () => {
  const source = new GitHubRepositoryStateSource(
    new MappingStateClient(),
    "acme",
  );

  const actions = await source.getActionsSettings("sample");

  assertEquals(actions.oidc, {
    subjectClaimTemplate: { source: "organization" },
    immutableSubject: true,
  });
});

Deno.test("ruleset state mapping preserves literals and maps enum fields", async () => {
  const source = new GitHubRepositoryStateSource(
    new MappingStateClient(),
    "acme",
  );

  const rulesets = await source.getRulesets("sample");
  const rules = rulesets[0].rules;

  assertEquals(rules[0], {
    type: "branch-name-pattern",
    operator: "starts-with",
    pattern: "pull-request",
  });
  assertEquals(
    (rules[1] as Extract<
      typeof rules[number],
      { readonly type: "pull-request" }
    >).dismissalRestriction,
    {
      enabled: true,
      allowedActors: [{
        id: 42,
        type: "integration-installation",
      }],
    },
  );
});
