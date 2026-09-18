import sodium from "libsodium-wrappers";
import { assert, assertEquals } from "@std/assert";
import {
  type GitHubClient,
  type GitHubQueryValue,
  GitHubRepositoryMutationSink,
} from "@octosmith/github";

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
    collections: "sparse",
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
          requiredReviewers: [],
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
  assertEquals(body.rules[1].parameters?.dismissal_restriction, {
    enabled: true,
    allowed_actors: [{
      id: 42,
      type: "IntegrationInstallation",
    }],
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
    type: "set-repository-secret",
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
