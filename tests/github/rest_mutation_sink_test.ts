import sodium from "libsodium-wrappers";
import { buildPlan } from "@octosmith/core";
import { assert, assertEquals } from "@std/assert";
import {
  type GitHubClient,
  type GitHubQueryValue,
  GitHubRepositoryMutationSink,
  GitHubRepositoryStateSource,
} from "@octosmith/github";
import { currentState } from "../plan/fixtures.ts";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, GitHubQueryValue>>;
}

class EnvironmentClient implements GitHubClient {
  readonly calls: Call[] = [];

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    this.calls.push({ method, path, query: options.query });

    if (method === "GET") {
      return this.get(path, options.query);
    }

    return Promise.resolve(undefined as T);
  }

  get<T>(
    path: string,
    query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    this.calls.push({ method: "GET", path, query });

    if (path.endsWith("/variables")) {
      const page = Number(query.page ?? 1);
      const variables = page === 1
        ? [
          { name: "KEEP", value: "old" },
          ...Array.from({ length: 99 }, (_, index) => ({
            name: "EXTRA_" + index,
            value: "x",
          })),
        ]
        : [{ name: "LATE", value: "x" }];

      return Promise.resolve({ variables } as T);
    }

    throw new Error("Unexpected GET " + path);
  }
}

Deno.test("environment sync preserves sparse siblings and paginates strict cleanup", async () => {
  const sparseClient = new EnvironmentClient();
  const sparseSink = new GitHubRepositoryMutationSink({
    client: sparseClient,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sparseSink.apply("sample", {
    type: "update-environment",
    collections: "explicit",
    environment: {
      name: "production",
      variables: [{ name: "KEEP", value: "new" }],
    },
  });

  assertEquals(
    sparseClient.calls.filter((call) => call.method === "DELETE"),
    [],
  );

  const strictClient = new EnvironmentClient();
  const strictSink = new GitHubRepositoryMutationSink({
    client: strictClient,
    owner: "acme",
    secretValue: () => "unused",
  });

  await strictSink.apply("sample", {
    type: "update-environment",
    collections: "strict",
    environment: {
      name: "production",
      variables: [{ name: "KEEP", value: "new" }],
    },
  });

  assert(
    strictClient.calls.some((call) =>
      call.method === "GET" &&
      call.path.endsWith("/variables") &&
      call.query?.page === 2
    ),
  );
  assert(
    strictClient.calls.some((call) =>
      call.method === "DELETE" &&
      call.path.endsWith("/variables/LATE")
    ),
  );
});

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

class MappingClient implements GitHubClient {
  readonly requests: RecordedRequest[] = [];

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    this.requests.push({ method, path, body: options.body });

    if (method === "GET") {
      return this.get(path, options.query);
    }

    return Promise.resolve(undefined as T);
  }

  get<T>(
    path: string,
    _query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    if (path.endsWith("/rulesets/1")) {
      return Promise.resolve({
        id: 1,
        name: "protect",
        target: "branch",
        enforcement: "active",
        bypass_actors: [{
          actor_id: 7,
          actor_type: "Team",
          bypass_mode: "always",
        }],
        conditions: {
          ref_name: {
            include: ["~DEFAULT_BRANCH"],
            exclude: [],
          },
        },
        rules: [],
      } as T);
    }

    if (path.endsWith("/actions/permissions")) {
      return Promise.resolve({
        enabled: true,
        allowed_actions: "all",
        sha_pinning_required: false,
      } as T);
    }

    if (path.endsWith("/actions/permissions/selected-actions")) {
      return Promise.resolve({
        github_owned_allowed: false,
        verified_allowed: false,
        patterns_allowed: [],
      } as T);
    }

    if (path.endsWith("/actions/oidc/customization/sub")) {
      return Promise.resolve({
        use_default: true,
        use_immutable_subject: false,
      } as T);
    }

    throw new Error("Unexpected GET " + path);
  }
}

Deno.test("ruleset updates materialize a complete GitHub document", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "update-ruleset",
    id: 1,
    changes: {
      name: "protect",
      enforcement: "evaluate",
    },
  });

  const update = client.requests.find((request) =>
    request.method === "PUT" && request.path.endsWith("/rulesets/1")
  );

  assertEquals(update?.body, {
    name: "protect",
    target: "branch",
    enforcement: "evaluate",
    bypass_actors: [{
      actor_id: 7,
      actor_type: "Team",
      bypass_mode: "always",
    }],
    conditions: {
      ref_name: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
    rules: [],
  });
});

Deno.test("ruleset transition to push drops ref conditions", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "update-ruleset",
    id: 1,
    changes: {
      name: "protect",
      target: "push",
    },
  });

  const update = client.requests.find((request) =>
    request.method === "PUT" && request.path.endsWith("/rulesets/1")
  )?.body as Record<string, unknown>;

  assertEquals(update.target, "push");
  assertEquals("conditions" in update, false);
});

Deno.test("ruleset mapping preserves literals and maps only enum fields", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "create-ruleset",
    ruleset: {
      name: "protect",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [
        {
          type: "branch-name-pattern",
          operator: "starts-with",
          pattern: "pull-request",
        },
        {
          type: "required-status-checks",
          doNotEnforceOnCreate: false,
          checks: [{ context: "ci", integrationId: 123 }],
          strict: true,
        },
        {
          type: "required-deployments",
          environments: ["production"],
        },
        {
          type: "code-scanning",
          tools: [{
            tool: "CodeQL",
            alertsThreshold: "errors-and-warnings",
            securityAlertsThreshold: "high-or-higher",
          }],
        },
        {
          type: "merge-queue",
          checkResponseTimeoutMinutes: 60,
          groupingStrategy: "all-green",
          maxEntriesToBuild: 5,
          maxEntriesToMerge: 5,
          mergeMethod: "squash",
          minEntriesToMerge: 1,
          minEntriesToMergeWaitMinutes: 0,
        },
        {
          type: "pull-request",
          allowedMergeMethods: ["squash"],
          dismissStaleReviewsOnPush: true,
          dismissalRestriction: {
            enabled: true,
            allowedActors: [{
              id: 42,
              type: "integration-installation",
            }],
          },
          requireCodeOwnerReview: true,
          requireLastPushApproval: true,
          requiredApprovingReviewCount: 1,
          requiredReviewThreadResolution: true,
          requiredReviewers: [{
            reviewerTeamId: 77,
            filePatterns: ["src/**"],
            minimumApprovals: 2,
          }],
        },
      ],
    },
  });

  const body = client.requests.find((request) =>
    request.method === "POST" && request.path.endsWith("/rulesets")
  )?.body as {
    rules: readonly {
      type: string;
      parameters?: Record<string, unknown>;
    }[];
  };

  assertEquals(body.rules[0].parameters, {
    operator: "starts_with",
    pattern: "pull-request",
  });
  assertEquals(body.rules[1].parameters, {
    do_not_enforce_on_create: false,
    required_status_checks: [{ context: "ci", integration_id: 123 }],
    strict_required_status_checks_policy: true,
  });
  assertEquals(body.rules[2].parameters, {
    required_deployment_environments: ["production"],
  });
  assertEquals(body.rules[3].parameters, {
    code_scanning_tools: [{
      tool: "CodeQL",
      alerts_threshold: "errors_and_warnings",
      security_alerts_threshold: "high_or_higher",
    }],
  });
  assertEquals(body.rules[4].parameters, {
    check_response_timeout_minutes: 60,
    grouping_strategy: "ALLGREEN",
    max_entries_to_build: 5,
    max_entries_to_merge: 5,
    merge_method: "SQUASH",
    min_entries_to_merge: 1,
    min_entries_to_merge_wait_minutes: 0,
  });
  assertEquals(body.rules[5].parameters?.required_reviewers, [{
    file_patterns: ["src/**"],
    minimum_approvals: 2,
    reviewer: {
      id: 77,
      type: "Team",
    },
  }]);
  assertEquals(body.rules[5].parameters?.dismissal_restriction, {
    enabled: true,
    allowed_actors: [{
      id: 42,
      type: "IntegrationInstallation",
    }],
  });
});

Deno.test("push rules map max file size to GitHub's parameter name", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "create-ruleset",
    ruleset: {
      name: "push",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [{
        type: "max-file-size",
        maxFileSizeMb: 25,
      }],
    },
  });

  const body = client.requests.find((request) =>
    request.method === "POST" && request.path.endsWith("/rulesets")
  )?.body as {
    rules: readonly {
      type: string;
      parameters?: Record<string, unknown>;
    }[];
  };

  assertEquals(body.rules[0], {
    type: "max_file_size",
    parameters: {
      max_file_size: 25,
    },
  });
});

Deno.test("selected Actions settings switch the repository to selected mode", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "update-actions-settings",
    settings: {
      selectedActions: {
        githubOwnedAllowed: true,
      },
    },
  });

  const permissions = client.requests.find((request) =>
    request.method === "PUT" &&
    request.path.endsWith("/actions/permissions")
  );

  assertEquals(permissions?.body, {
    enabled: true,
    allowed_actions: "selected",
    sha_pinning_required: false,
  });
});

Deno.test("organization OIDC templates do not collapse to GitHub defaults", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "update-actions-oidc",
    settings: {
      subjectClaimTemplate: { source: "organization" },
    },
  });

  const update = client.requests.find((request) =>
    request.method === "PUT" &&
    request.path.endsWith("/actions/oidc/customization/sub")
  );

  assertEquals(update?.body, {
    use_default: false,
    use_immutable_subject: false,
  });
});

Deno.test("managed file uploads preserve UTF-8 content through base64", async () => {
  const client = new MappingClient();
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });

  await sink.apply("sample", {
    type: "create-file",
    file: {
      path: "README.md",
      ensure: "exact",
      content: "ciao 👋",
    },
  });

  const request = client.requests.find((item) =>
    item.method === "PUT" && item.path.endsWith("/contents/README.md")
  );
  const body = request?.body as { content: string };
  const binary = atob(body.content);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  assertEquals(new TextDecoder().decode(bytes), "ciao 👋");
});

class SecretClient implements GitHubClient {
  readonly requests: RecordedRequest[] = [];

  constructor(readonly publicKey: string) {}

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    this.requests.push({ method, path, body: options.body });

    if (method === "GET") {
      return this.get(path);
    }

    return Promise.resolve(undefined as T);
  }

  get<T>(
    path: string,
    _query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    if (path.endsWith("/actions/secrets/public-key")) {
      return Promise.resolve({
        key_id: "key-1",
        key: this.publicKey,
      } as T);
    }

    throw new Error("Unexpected GET " + path);
  }
}

Deno.test("repository secrets are sealed with GitHub's public key", async () => {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const publicKey = sodium.to_base64(
    keyPair.publicKey,
    sodium.base64_variants.ORIGINAL,
  );
  const client = new SecretClient(publicKey);
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "super-secret",
  });

  await sink.apply("sample", {
    type: "set-actions-secret",
    secret: "TOKEN",
  });

  const request = client.requests.find((item) =>
    item.method === "PUT" && item.path.endsWith("/actions/secrets/TOKEN")
  );
  const body = request?.body as {
    encrypted_value: string;
    key_id: string;
  };
  const encrypted = sodium.from_base64(
    body.encrypted_value,
    sodium.base64_variants.ORIGINAL,
  );
  const decrypted = sodium.crypto_box_seal_open(
    encrypted,
    keyPair.publicKey,
    keyPair.privateKey,
  );

  assertEquals(body.key_id, "key-1");
  assertEquals(sodium.to_string(decrypted), "super-secret");
});

class StatefulRulesetClient implements GitHubClient {
  readonly requests: RecordedRequest[] = [];
  ruleset: Record<string, unknown>;

  constructor(ruleset: Record<string, unknown>) {
    this.ruleset = structuredClone(ruleset);
  }

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    this.requests.push({ method, path, body: options.body });

    if (method === "GET") {
      return this.get(path, options.query);
    }

    if (method === "PUT" && path.endsWith("/rulesets/1")) {
      this.ruleset = {
        id: 1,
        source_type: "Repository",
        ...(options.body as Record<string, unknown>),
      };
      return Promise.resolve(this.ruleset as T);
    }

    if (method === "POST" && path.endsWith("/rulesets")) {
      this.ruleset = {
        id: 1,
        source_type: "Repository",
        ...(options.body as Record<string, unknown>),
      };
      return Promise.resolve(this.ruleset as T);
    }

    return Promise.resolve(undefined as T);
  }

  get<T>(
    path: string,
    _query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    if (path.endsWith("/rulesets")) {
      return Promise.resolve([{
        id: 1,
        source_type: "Repository",
      }] as T);
    }

    if (path.endsWith("/rulesets/1")) {
      return Promise.resolve(structuredClone(this.ruleset) as T);
    }

    throw new Error("Unexpected GET " + path);
  }
}

Deno.test("ruleset sparse update converges through GitHub round trip", async () => {
  const client = new StatefulRulesetClient({
    id: 1,
    source_type: "Repository",
    name: "protect",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{
      actor_id: 7,
      actor_type: "Team",
      bypass_mode: "always",
    }],
    conditions: {
      ref_name: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
    rules: [
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
      { type: "deletion" },
    ],
  });
  const source = new GitHubRepositoryStateSource(client, "acme");
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });
  const desired = {
    repository: "sample",
    template: "code",
    rulesets: [{
      name: "protect",
      rules: [{
        type: "required-status-checks",
        strict: false,
      }],
    }],
  } as const;

  const before = await source.getRulesets("sample");
  const plan = buildPlan(currentState({ rulesets: before }), desired);
  assertEquals(plan.operations.length, 1);

  await sink.apply("sample", plan.operations[0]);

  const after = await source.getRulesets("sample");
  assertEquals(buildPlan(currentState({ rulesets: after }), desired), {
    repository: "sample",
    operations: [],
  });
  assertEquals(after[0].enforcement, "active");
  assertEquals(after[0].bypassActors, [{
    actorType: "team",
    actorId: 7,
    bypassMode: "always",
  }]);
  assertEquals(
    "conditions" in after[0] ? after[0].conditions : undefined,
    {
      refName: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
  );
  assertEquals(after[0].rules, [
    {
      type: "required-status-checks",
      doNotEnforceOnCreate: false,
      checks: [{ context: "ci", integrationId: 123 }],
      strict: false,
    },
    { type: "deletion" },
  ]);
});

for (
  const [groupingStrategy, restGrouping] of [
    ["all-green", "ALLGREEN"],
    ["head-green", "HEADGREEN"],
  ] as const
) {
  for (
    const [mergeMethod, restMethod] of [
      ["merge", "MERGE"],
      ["squash", "SQUASH"],
      ["rebase", "REBASE"],
    ] as const
  ) {
    Deno.test(
      `merge queue maps ${groupingStrategy} and ${mergeMethod} round trip`,
      async () => {
        const client = new StatefulRulesetClient({
          id: 1,
          source_type: "Repository",
          name: "queue",
          target: "branch",
          enforcement: "active",
          bypass_actors: [],
          conditions: {
            ref_name: {
              include: ["~DEFAULT_BRANCH"],
              exclude: [],
            },
          },
          rules: [],
        });
        const sink = new GitHubRepositoryMutationSink({
          client,
          owner: "acme",
          secretValue: () => "unused",
        });
        const source = new GitHubRepositoryStateSource(client, "acme");

        await sink.apply("sample", {
          type: "create-ruleset",
          ruleset: {
            name: "queue",
            target: "branch",
            enforcement: "active",
            bypassActors: [],
            conditions: {
              refName: {
                include: ["~DEFAULT_BRANCH"],
                exclude: [],
              },
            },
            rules: [{
              type: "merge-queue",
              checkResponseTimeoutMinutes: 60,
              groupingStrategy,
              maxEntriesToBuild: 5,
              maxEntriesToMerge: 5,
              mergeMethod,
              minEntriesToMerge: 1,
              minEntriesToMergeWaitMinutes: 0,
            }],
          },
        });

        const restRule = (client.ruleset.rules as readonly {
          parameters: Record<string, unknown>;
        }[])[0];
        assertEquals(restRule.parameters.grouping_strategy, restGrouping);
        assertEquals(restRule.parameters.merge_method, restMethod);

        const readBack = await source.getRulesets("sample");
        const rule = readBack[0].rules[0];
        assertEquals(
          rule.type === "merge-queue" ? rule.groupingStrategy : undefined,
          groupingStrategy,
        );
        assertEquals(
          rule.type === "merge-queue" ? rule.mergeMethod : undefined,
          mergeMethod,
        );
      },
    );
  }
}
