import { assertEquals, assertRejects } from "@std/assert";
import { buildPlan } from "@octosmith/core";
import {
  FetchGitHubClient,
  type GitHubClient,
  type GitHubQueryValue,
  GitHubRepositoryStateSource,
} from "@octosmith/github";
import { currentState } from "../plan/fixtures.ts";

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

    if (path === "/repos/acme/sample/dependabot/secrets") {
      const count = page === 1 ? 100 : 1;
      return Promise.resolve({
        secrets: Array.from({ length: count }, (_, index) => ({
          name: "SECRET_" + ((page - 1) * 100 + index),
        })),
      } as T);
    }

    throw new Error("Unexpected request: " + path);
  }
}

Deno.test("state source paginates array and wrapped collections", async () => {
  const client = new PagingClient();
  const source = new GitHubRepositoryStateSource(client, "acme");

  const [teams, variables, dependabotSecrets] = await Promise.all([
    source.getTeams("sample"),
    source.getActionsVariables("sample"),
    source.getDependabotSecrets("sample"),
  ]);

  assertEquals(teams.length, 101);
  assertEquals(teams[100].team, "team-100");
  assertEquals(variables.length, 101);
  assertEquals(variables[100], { name: "VAR_100", value: "100" });
  assertEquals(dependabotSecrets.length, 101);
  assertEquals(dependabotSecrets[100], "SECRET_100");
  assertEquals(client.requests.sort(), [
    "/repos/acme/sample/actions/variables?page=1",
    "/repos/acme/sample/actions/variables?page=2",
    "/repos/acme/sample/dependabot/secrets?page=1",
    "/repos/acme/sample/dependabot/secrets?page=2",
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
      return Promise.resolve([
        { id: 1, source_type: "Repository" },
        { id: 2, source_type: "Repository" },
      ] as T);
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
            type: "required_status_checks",
            parameters: {
              do_not_enforce_on_create: false,
              required_status_checks: [{
                context: "ci",
                integration_id: 123,
              }],
              strict_required_status_checks_policy: true,
            },
          },
          {
            type: "required_deployments",
            parameters: {
              required_deployment_environments: ["production"],
            },
          },
          {
            type: "code_scanning",
            parameters: {
              code_scanning_tools: [{
                tool: "CodeQL",
                alerts_threshold: "errors_and_warnings",
                security_alerts_threshold: "high_or_higher",
              }],
            },
          },
          {
            type: "merge_queue",
            parameters: {
              check_response_timeout_minutes: 60,
              grouping_strategy: "ALLGREEN",
              max_entries_to_build: 5,
              max_entries_to_merge: 5,
              merge_method: "SQUASH",
              min_entries_to_merge: 1,
              min_entries_to_merge_wait_minutes: 0,
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
              required_reviewers: [{
                file_patterns: ["src/**"],
                minimum_approvals: 2,
                reviewer: {
                  id: 77,
                  type: "Team",
                },
              }],
            },
          },
        ],
      } as T);
    }

    if (path.endsWith("/rulesets/2")) {
      return Promise.resolve({
        id: 2,
        name: "push",
        target: "push",
        enforcement: "active",
        bypass_actors: [],
        rules: [{
          type: "max_file_size",
          parameters: {
            max_file_size: 25,
          },
        }],
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
  assertEquals(rulesets.length, 2);
  const rules = rulesets[0].rules;

  assertEquals(
    "conditions" in rulesets[0] ? rulesets[0].conditions : undefined,
    {
      refName: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
  );
  assertEquals(rules[0], {
    type: "branch-name-pattern",
    operator: "starts-with",
    pattern: "pull-request",
  });
  assertEquals(rules[1], {
    type: "required-status-checks",
    doNotEnforceOnCreate: false,
    checks: [{ context: "ci", integrationId: 123 }],
    strict: true,
  });
  assertEquals(rules[2], {
    type: "required-deployments",
    environments: ["production"],
  });
  assertEquals(rules[3], {
    type: "code-scanning",
    tools: [{
      tool: "CodeQL",
      alertsThreshold: "errors-and-warnings",
      securityAlertsThreshold: "high-or-higher",
    }],
  });
  assertEquals(rules[4], {
    type: "merge-queue",
    checkResponseTimeoutMinutes: 60,
    groupingStrategy: "all-green",
    maxEntriesToBuild: 5,
    maxEntriesToMerge: 5,
    mergeMethod: "squash",
    minEntriesToMerge: 1,
    minEntriesToMergeWaitMinutes: 0,
  });
  assertEquals(
    (rules[5] as Extract<
      typeof rules[number],
      { readonly type: "pull-request" }
    >).requiredReviewers,
    [{
      reviewerTeamId: 77,
      filePatterns: ["src/**"],
      minimumApprovals: 2,
    }],
  );
  assertEquals(
    (rules[5] as Extract<
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

  assertEquals(rulesets[1].rules, [{
    type: "max-file-size",
    maxFileSizeMb: 25,
  }]);
});

Deno.test("documented ruleset state supports sparse planner updates", async () => {
  const source = new GitHubRepositoryStateSource(
    new MappingStateClient(),
    "acme",
  );
  const rulesets = await source.getRulesets("sample");

  const plan = buildPlan(
    currentState({ rulesets }),
    {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "protect",
        rules: [{
          type: "required-status-checks",
          strict: false,
        }],
      }],
    },
  );

  const update = plan.operations[0];
  assertEquals(update.type, "update-ruleset");
  if (update.type !== "update-ruleset") {
    throw new Error("Expected update-ruleset");
  }

  assertEquals(update.changes.rules?.[1], {
    type: "required-status-checks",
    doNotEnforceOnCreate: false,
    checks: [{ context: "ci", integrationId: 123 }],
    strict: false,
  });
  assertEquals(update.changes.rules?.[0], {
    type: "branch-name-pattern",
    operator: "starts-with",
    pattern: "pull-request",
  });
  assertEquals(update.changes.enforcement, undefined);
});

Deno.test("managed files preserve UTF-8 content and SHA", async () => {
  const source = fileSource(
    new Response(
      JSON.stringify({
        type: "file",
        content: encodeBase64("ciao 👋"),
        encoding: "base64",
        sha: "abc123",
      }),
      { status: 200 },
    ),
  );

  assertEquals(await source.getFile("sample", "README.md"), {
    path: "README.md",
    content: "ciao 👋",
    sha: "abc123",
  });
});

Deno.test("managed file 404 returns undefined", async () => {
  const source = fileSource(
    new Response(
      JSON.stringify({ message: "Not Found" }),
      { status: 404, statusText: "Not Found" },
    ),
  );

  assertEquals(await source.getFile("sample", "missing.txt"), undefined);
});

Deno.test("managed file directory responses are rejected", async () => {
  const source = fileSource(
    new Response(
      JSON.stringify({
        type: "dir",
        content: "",
        encoding: "base64",
        sha: "abc123",
      }),
      { status: 200 },
    ),
  );

  await assertRejects(
    () => source.getFile("sample", "docs"),
    Error,
    "Managed path is not a base64 file: docs",
  );
});

Deno.test("managed files reject unsupported encodings", async () => {
  const source = fileSource(
    new Response(
      JSON.stringify({
        type: "file",
        content: "hello",
        encoding: "utf-8",
        sha: "abc123",
      }),
      { status: 200 },
    ),
  );

  await assertRejects(
    () => source.getFile("sample", "README.md"),
    Error,
    "Managed path is not a base64 file: README.md",
  );
});

Deno.test("managed file permission failures propagate", async () => {
  const source = fileSource(
    new Response(
      JSON.stringify({ message: "Forbidden" }),
      { status: 403, statusText: "Forbidden" },
    ),
  );

  await assertRejects(
    () => source.getFile("sample", "README.md"),
    Error,
    "403 Forbidden",
  );
});

function fileSource(response: Response): GitHubRepositoryStateSource {
  const client = new FetchGitHubClient({
    token: "token",
    fetch: () => Promise.resolve(response.clone()),
  });

  return new GitHubRepositoryStateSource(client, "acme");
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
