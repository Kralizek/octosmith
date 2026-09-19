import { assertEquals, assertRejects } from "@std/assert";
import sodium from "libsodium-wrappers";
import {
  applyPlan,
  FetchGitHubClient,
  GitHubRepositoryMutationSink,
} from "@octosmith/github";

Deno.test("missing Actions secret prevents all mutations including strict deletions", async () => {
  const requests: string[] = [];
  const sink = missingSecretSink(requests);
  await assertRejects(
    () =>
      applyPlan(sink, {
        repository: "sample",
        operations: [
          {
            type: "update-repository-settings",
            settings: { hasIssues: false },
          },
          { type: "remove-actions-secret", secret: "OLD" },
          { type: "set-actions-secret", secret: { name: "TARGET", source: "NEW" } },
        ],
      }, { continueOnError: true }),
    Error,
    "Missing environment value: NEW",
  );
  assertEquals(requests, []);
});

Deno.test("missing Dependabot secret prevents all mutations", async () => {
  const requests: string[] = [];
  await assertRejects(
    () =>
      applyPlan(missingSecretSink(requests), {
        repository: "sample",
        operations: [
          {
            type: "update-repository-settings",
            settings: { hasIssues: false },
          },
          { type: "remove-dependabot-secret", secret: "OLD" },
          { type: "set-dependabot-secret", secret: { name: "TARGET", source: "NEW" } },
        ],
      }),
    Error,
    "Missing environment value: NEW",
  );
  assertEquals(requests, []);
});

Deno.test("missing environment secret prevents earlier repository and environment deletions", async () => {
  const requests: string[] = [];
  const sink = missingSecretSink(requests);
  await assertRejects(
    () =>
      applyPlan(sink, {
        repository: "sample",
        operations: [
          { type: "remove-actions-secret", secret: "OLD" },
          { type: "delete-environment", name: "staging" },
          {
            type: "update-environment",
            collections: "strict",
            environment: { name: "production", secrets: [{ name: "TARGET", source: "NEW" }] },
          },
        ],
      }),
    Error,
    "Missing environment value: NEW",
  );
  assertEquals(requests, []);
});

Deno.test("missing secret prevents creating a new environment", async () => {
  const requests: string[] = [];
  await assertRejects(
    () =>
      applyPlan(missingSecretSink(requests), {
        repository: "sample",
        operations: [{
          type: "create-environment",
          environment: { name: "production", secrets: [{ name: "TARGET", source: "NEW" }], variables: [] },
        }],
      }),
    Error,
    "Missing environment value: NEW",
  );
  assertEquals(requests, []);
});

Deno.test("secret values are snapshotted once per name before mutations", async () => {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  let providerCalls = 0;
  const written: string[] = [];
  const sink = new GitHubRepositoryMutationSink({
    owner: "acme",
    secretValue: () => {
      providerCalls++;
      return "snapshot-" + providerCalls;
    },
    client: new FetchGitHubClient({
      token: "fake",
      fetch: (input, init) => {
        assertEquals(providerCalls, 1);
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/public-key")) {
          return Promise.resolve(
            Response.json({
              key_id: "key",
              key: sodium.to_base64(
                keys.publicKey,
                sodium.base64_variants.ORIGINAL,
              ),
            }),
          );
        }
        if (init?.method === "GET") {
          return Promise.resolve(Response.json({ secrets: [] }));
        }
        const body = JSON.parse(String(init?.body));
        written.push(sodium.to_string(sodium.crypto_box_seal_open(
          sodium.from_base64(
            body.encrypted_value,
            sodium.base64_variants.ORIGINAL,
          ),
          keys.publicKey,
          keys.privateKey,
        )));
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    }),
  });
  const result = await applyPlan(sink, {
    repository: "sample",
    operations: [
      {
        type: "set-actions-secret",
        secret: { name: "ACTIONS_SHARED", source: "SHARED" },
      },
      {
        type: "set-dependabot-secret",
        secret: { name: "DEPENDABOT_SHARED", source: "SHARED" },
      },
      {
        type: "update-environment",
        collections: "explicit",
        environment: {
          name: "production",
          secrets: [{ name: "ENV_SHARED", source: "SHARED" }],
        },
      },
    ],
  });
  assertEquals(result.operations.map((operation) => operation.status), [
    "applied",
    "applied",
    "applied",
  ]);
  assertEquals(written, ["snapshot-1", "snapshot-1", "snapshot-1"]);
  assertEquals(providerCalls, 1);
});

function missingSecretSink(requests: string[]): GitHubRepositoryMutationSink {
  return new GitHubRepositoryMutationSink({
    owner: "acme",
    secretValue: (name) => {
      throw new Error("Missing environment value: " + name);
    },
    client: new FetchGitHubClient({
      token: "fake",
      fetch: (input, init) => {
        requests.push(init?.method + " " + String(input));
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    }),
  });
}
