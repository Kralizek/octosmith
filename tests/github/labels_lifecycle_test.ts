import { assertEquals } from "@std/assert";
import {
  buildPlan,
  GitHubRepositoryMutationSink,
  readCurrentState,
  type DesiredState,
  type GitHubClient,
  type GitHubRequestOptions,
  type Label,
  type RepositoryStateSource,
} from "@octosmith/octosmith";
import { currentRepositorySettings } from "../plan/fixtures.ts";

/** A mutable GitHub label collection shared by the reader and mutation transport. */
class StatefulLabels implements GitHubClient {
  readonly labels = new Map<string, Label>();
  readonly mutations: string[] = [];

  getLabels(): readonly Label[] {
    return [...this.labels.values()].map((label) => ({ ...label }));
  }

  externalUpsert(label: Label): void {
    this.labels.set(label.name.toLowerCase(), { ...label });
  }

  request<T>(
    method: string,
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<T> {
    const base = "/repos/acme/sample/labels";
    if (!path.startsWith(base)) throw new Error("Unexpected request: " + path);
    const name = path === base
      ? undefined
      : decodeURIComponent(path.slice(base.length + 1));
    if (method === "POST" && name === undefined) {
      const label = options.body as Label;
      if (this.labels.has(label.name.toLowerCase())) {
        throw new Error("Label already exists: " + label.name);
      }
      this.externalUpsert(label);
      this.mutations.push("create:" + label.name);
    } else if (method === "PATCH" && name !== undefined) {
      const current = this.labels.get(name.toLowerCase());
      if (!current) throw new Error("Missing label: " + name);
      const body = options.body as {
        new_name: string;
        color: string;
        description?: string;
      };
      this.labels.delete(name.toLowerCase());
      this.externalUpsert({
        name: body.new_name,
        color: body.color,
        description: body.description ?? current.description,
      });
      this.mutations.push("update:" + name);
    } else if (method === "DELETE" && name !== undefined) {
      if (!this.labels.delete(name.toLowerCase())) {
        throw new Error("Missing label: " + name);
      }
      this.mutations.push("delete:" + name);
    } else {
      throw new Error("Unexpected request: " + method + " " + path);
    }
    return Promise.resolve(undefined as T);
  }

  get<T>(_path: string): Promise<T> {
    throw new Error("Unexpected GET");
  }
}

function stateSource(client: StatefulLabels): RepositoryStateSource {
  // This focused test declares only labels; readCurrentState should not
  // request unrelated resource families.
  return {
    getRepositorySettings: () => Promise.resolve(currentRepositorySettings()),
    getLabels: () => Promise.resolve(client.getLabels()),
  } as unknown as RepositoryStateSource;
}

Deno.test("label lifecycle reconciles external drift and strict deletions", async () => {
  const client = new StatefulLabels();
  const source = stateSource(client);
  const sink = new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
  });
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:issues",
    labels: [
      { name: "security", color: "b60205", description: "Security findings" },
      { name: "severity:high", color: "d93f0b" },
    ],
  };
  async function reconcile(target: DesiredState) {
    const current = await readCurrentState(source, target);
    const plan = buildPlan(current, target);
    for (const operation of plan.operations) {
      await sink.apply(target.repository, operation);
    }
    return plan.operations;
  }

  // The first run creates both labels; a repeat plan is idempotent.
  assertEquals((await reconcile(desired)).map((item) => item.type), [
    "create-label",
    "create-label",
  ]);
  assertEquals((await reconcile(desired)).length, 0);

  // External drift in owned definitions is detected and corrected. Omitted
  // descriptions remain unchanged rather than being overwritten.
  client.externalUpsert({
    name: "Security",
    color: "ffffff",
    description: "Manually changed",
  });
  client.externalUpsert({
    name: "severity:high",
    color: "d93f0b",
    description: "Keep this description",
  });
  const drift = await readCurrentState(source, desired);
  assertEquals(buildPlan(drift, desired).operations, [{
    type: "update-label",
    name: "Security",
    label: desired.labels![0],
  }]);
  await reconcile(desired);
  assertEquals(client.labels.get("security"), desired.labels![0]);
  assertEquals(client.labels.get("severity:high")?.description, "Keep this description");

  // Explicit mode does not own or delete unexpected labels.
  client.externalUpsert({ name: "external", color: "123456" });
  assertEquals(await reconcile(desired), []);
  assertEquals(client.labels.has("external"), true);

  // Strict mode sees the entire collection and deletes only undeclared labels.
  const strict = { ...desired, collections: "strict" as const };
  const strictPlan = await readCurrentState(source, strict);
  assertEquals(buildPlan(strictPlan, strict).operations, [{
    type: "delete-label",
    name: "external",
  }]);
  assertEquals(await reconcile(strict), [{
    type: "delete-label",
    name: "external",
  }]);
  assertEquals(client.labels.has("external"), false);
  assertEquals((await reconcile(strict)).length, 0);

  // Declared empty strict collections delete all remaining labels.
  assertEquals((await reconcile({ ...strict, labels: [] })).map((op) => op.type), [
    "delete-label",
    "delete-label",
  ]);
  assertEquals(client.labels.size, 0);
  assertEquals(client.mutations, [
    "create:security",
    "create:severity:high",
    "update:Security",
    "delete:external",
    "delete:security",
    "delete:severity:high",
  ]);
});
