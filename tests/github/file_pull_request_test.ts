import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { buildFileOperations } from "../../packages/octosmith/plan/build.ts";
import {
  managedPullRequestBody,
  reconcileFilePullRequest,
} from "../../packages/octosmith/github/file_pull_request.ts";
import type {
  ApplyPlanResult,
  DesiredFile,
  FileChangesPullRequestConfiguration,
  GitHubClient,
  GitHubRequestOptions,
  PullRequestResult,
} from "@octosmith/octosmith";
import {
  applyPlan,
  GitHubRepositoryMutationSink,
  GitHubRequestError,
} from "@octosmith/octosmith";
import { createGitHubRuntime, main } from "../../packages/cli/mod.ts";

type Tree = Record<string, string>;
interface Commit {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

class ReconciliationClient implements GitHubClient {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly refs = new Map<string, string>();
  readonly trees = new Map<string, Tree>();
  readonly commits = new Map<string, Commit>();
  readonly outcomes: PullRequestResult[] = [];
  readonly pulls: {
    number: number;
    html_url: string;
    state: string;
    title: string;
    body: string | null;
    head: { ref: string; sha: string; repo: { full_name: string } };
    base: { ref: string; repo: { full_name: string } };
    labels: { name: string }[];
  }[] = [];
  beforeAtomic?: () => void;
  afterAtomic?: () => void;
  beforePullRead?: () => void;
  afterRequest?: (
    method: string,
    path: string,
    options: GitHubRequestOptions,
  ) => void | Promise<void>;
  failLabels = false;
  failClose = false;
  failCreate = false;
  failUpdate = false;
  failCleanup = false;
  lastResult?: ApplyPlanResult;
  nextId = 1;

  constructor(files: Tree = {}) {
    this.advanceTarget(files);
  }

  advanceTarget(files: Tree): void {
    const tree = this.storeTree(files);
    const sha = "commit-" + this.nextId++;
    this.commits.set(sha, {
      sha,
      message: "Target",
      tree: { sha: tree },
      parents: [],
    });
    this.refs.set("main", sha);
  }

  storeTree(files: Tree): string {
    const sorted = Object.fromEntries(
      Object.entries(files).sort(([left], [right]) => left < right ? -1 : 1),
    );
    for (const [sha, existing] of this.trees) {
      if (JSON.stringify(existing) === JSON.stringify(sorted)) return sha;
    }
    const sha = "tree-" + this.nextId++;
    this.trees.set(sha, sorted);
    return sha;
  }

  files(ref = "octosmith/reconcile"): Tree {
    const sha = this.refs.get(ref) ?? ref;
    return this.trees.get(this.commits.get(sha)!.tree.sha)!;
  }

  snapshot(files: readonly DesiredFile[]) {
    return { branch: "main", baseSha: this.refs.get("main")!, files };
  }

  operations(files: readonly DesiredFile[]) {
    return buildFileOperations(
      Object.entries(this.files("main")).map(([path, content]) => ({
        path,
        content,
        sha: "blob:" + content,
      })),
      files,
    );
  }

  async reconcile(
    files: readonly DesiredFile[],
    settings: FileChangesPullRequestConfiguration = {},
    allowClosure = true,
  ) {
    const result = await applyPlan(
      new GitHubRepositoryMutationSink({
        client: this,
        owner: "acme",
        secretValue: () => "unused",
        allowClosure,
        fileChanges: {
          mode: "pull_request",
          commit: { message: "Sync {organization}/{repository}" },
          pullRequest: settings,
        },
      }),
      {
        repository: "sample",
        managedFiles: this.snapshot(files),
        operations: this.operations(files),
      },
      {
        onPullRequest: (outcome) => {
          this.outcomes.push(outcome);
        },
      },
    );
    this.lastResult = result;
    const error = result.error ??
      result.operations.find((operation) => operation.status === "failed")
        ?.error;
    if (error) throw new Error(error);
    return result;
  }

  get<T>(path: string, query: GitHubRequestOptions["query"] = {}): Promise<T> {
    return this.request("GET", path, { query });
  }

  async request<T>(
    method: string,
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<T> {
    this.requests.push({ method, path, body: options.body });
    const value = await this.respond(method, path, options);
    const response = structuredClone(value) as T;
    await this.afterRequest?.(method, path, options);
    return response;
  }

  respond(
    method: string,
    path: string,
    options: GitHubRequestOptions,
  ): unknown {
    const body = options.body as Record<string, unknown>;
    if (method === "GET") {
      if (path === "/orgs/acme/repos") {
        return [{ name: "sample", visibility: "private" }];
      }
      if (path === "/repos/acme/sample") {
        return {
          name: "sample",
          node_id: "repository-id",
          default_branch: "main",
          topics: [],
          visibility: "private",
        };
      }
      if (path.includes("/git/ref/heads/")) {
        const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]);
        const sha = this.refs.get(branch);
        if (!sha && !options.allowNotFound) throw new Error("Missing ref");
        return sha ? { object: { sha } } : undefined;
      }
      if (path.includes("/git/commits/")) {
        return this.commits.get(path.split("/git/commits/")[1]);
      }
      if (path.includes("/contents/")) {
        const name = decodeURIComponent(path.split("/contents/")[1]);
        const content = this.files(String(options.query?.ref))[name];
        return content === undefined ? undefined : {
          type: "file",
          encoding: "base64",
          content: btoa(content),
          sha: "blob:" + content,
        };
      }
      if (path.endsWith("/pulls")) {
        return this.pulls.filter((pull) => pull.state === "open").map((
          pull,
        ) => ({
          ...pull,
          head: { ...pull.head, sha: this.refs.get(pull.head.ref) },
        }));
      }
      if (/\/pulls\/\d+$/.test(path)) {
        this.beforePullRead?.();
        const pull = this.pulls.find((pull) =>
          pull.number === Number(path.split("/").at(-1))
        )!;
        return {
          ...pull,
          head: { ...pull.head, sha: this.refs.get(pull.head.ref) },
        };
      }
    }
    if (method === "POST" && path.endsWith("/git/trees")) {
      const files = { ...this.trees.get(String(body.base_tree)) };
      for (
        const entry of body.tree as {
          path: string;
          sha?: null;
          content?: string;
        }[]
      ) {
        if (entry.sha === null) delete files[entry.path];
        else files[entry.path] = entry.content!;
      }
      return { sha: this.storeTree(files) };
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      const sha = "commit-" + this.nextId++;
      const commit = {
        sha,
        message: String(body.message),
        tree: { sha: String(body.tree) },
        parents: (body.parents as string[]).map((sha) => ({ sha })),
      };
      this.commits.set(sha, commit);
      return commit;
    }
    if (method === "POST" && path === "/graphql") {
      const { refUpdates } = (body.variables as {
        input: {
          refUpdates: {
            name: string;
            beforeOid: string;
            afterOid: string;
            force: boolean;
          }[];
        };
      }).input;
      if (refUpdates.length === 1 && this.failCleanup) {
        throw new Error("Lock deletion failed");
      }
      if (refUpdates.length > 1) {
        this.beforeAtomic?.();
        assertEquals(refUpdates.length, 3);
        assertEquals(refUpdates[0].force, false);
        assertEquals(refUpdates[0].afterOid, refUpdates[0].beforeOid);
        assertEquals(refUpdates[1].name, "refs/heads/octosmith/reconcile");
        assertEquals(refUpdates[2].name, "refs/heads/octosmith/reconcile-lock");
        assertEquals(refUpdates[2].force, false);
      }
      if (
        refUpdates.some((ref) =>
          (this.refs.get(ref.name.slice(11)) ?? "0".repeat(40)) !==
            ref.beforeOid
        )
      ) {
        return { errors: [{ message: "Expected old SHA mismatch" }] };
      }
      for (const ref of refUpdates) {
        if (ref.afterOid === "0".repeat(40)) {
          this.refs.delete(ref.name.slice(11));
        } else this.refs.set(ref.name.slice(11), ref.afterOid);
      }
      if (refUpdates.length > 1) this.afterAtomic?.();
      return { data: { updateRefs: { clientMutationId: null } } };
    }
    if (method === "POST" && path.endsWith("/pulls")) {
      if (this.failCreate) throw new Error("PR creation failed");
      const number = this.pulls.length + 1;
      const pull = {
        number,
        html_url: "https://github.example/acme/sample/pull/" + number,
        state: "open",
        title: String(body.title),
        body: String(body.body),
        head: {
          ref: String(body.head),
          sha: this.refs.get(String(body.head))!,
          repo: { full_name: "acme/sample" },
        },
        base: { ref: String(body.base), repo: { full_name: "acme/sample" } },
        labels: [],
      };
      this.pulls.push(pull);
      return pull;
    }
    if (method === "PATCH" && /\/pulls\/\d+$/.test(path)) {
      if (body.state === "closed" && this.failClose) {
        throw new Error("PR closure failed");
      }
      if (body.state !== "closed" && this.failUpdate) {
        throw new Error("PR body update failed");
      }
      const pull = this.pulls.find((pull) =>
        pull.number === Number(path.split("/").at(-1))
      )!;
      Object.assign(pull, body);
      return {
        ...pull,
        head: { ...pull.head, sha: this.refs.get(pull.head.ref) },
      };
    }
    if (method === "POST" && path.endsWith("/labels")) {
      if (this.failLabels) throw new Error("Label update failed");
      const pull = this.pulls.find((pull) =>
        pull.number === Number(path.split("/").at(-2))
      )!;
      pull.labels.push(...(body.labels as string[]).map((name) => ({ name })));
      return pull.labels;
    }
    throw new Error("Unexpected " + method + " " + path);
  }
}

const fileA = { path: "A.md", ensure: "exact", content: "A" } as const;
const fileB = { path: "B.md", ensure: "exact", content: "B" } as const;

for (const action of ["opened", "updated", "closed"] as const) {
  for (
    const boundary of [
      "branch transaction",
      "PR response",
      "lock release",
    ] as const
  ) {
    Deno.test(
      "target advancement after " + boundary + " fails " + action +
        " reconciliation",
      async () => {
        const client = new ReconciliationClient();
        if (action !== "opened") await client.reconcile([fileA]);
        const originalOutcomes = [...client.outcomes];
        client.afterRequest = (method, path, options) => {
          const body = options.body as {
            variables?: { input: { refUpdates: unknown[] } };
          } | undefined;
          const moved = boundary === "branch transaction"
            ? path === "/graphql" &&
              body?.variables?.input.refUpdates.length === 3
            : boundary === "lock release"
            ? path === "/graphql" &&
              body?.variables?.input.refUpdates.length === 1
            : action === "opened"
            ? method === "POST" && path.endsWith("/pulls")
            : method === "PATCH" && /\/pulls\/\d+$/.test(path);
          if (moved) {
            client.advanceTarget({ upstream: "moved during " + boundary });
          }
        };
        await assertRejects(
          () =>
            client.reconcile(
              action === "closed"
                ? []
                : action === "updated"
                ? [fileA, fileB]
                : [fileA],
            ),
          Error,
          "target changed",
        );
        const completed = client.outcomes.slice(originalOutcomes.length);
        assertEquals(
          completed.map((outcome) => outcome.action),
          boundary === "lock release" ? [action] : [],
        );
        assertEquals(client.lastResult?.pullRequests ?? [], completed);
        assertEquals(client.refs.has("octosmith/reconcile-lock"), false);
        assertEquals(client.files("main"), {
          upstream: "moved during " + boundary,
        });
      },
    );
  }
}

for (const action of ["updated", "closed"] as const) {
  Deno.test(
    "target advancement while reading latest PR prevents " + action,
    async () => {
      const client = new ReconciliationClient();
      await client.reconcile([fileA]);
      const before = client.requests.length;
      client.beforePullRead = () =>
        client.advanceTarget({ upstream: "advanced" });
      await assertRejects(
        () => client.reconcile(action === "closed" ? [] : [fileA, fileB]),
        Error,
        "target changed",
      );
      assertEquals(client.outcomes.map((outcome) => outcome.action), [
        "opened",
      ]);
      assertEquals(client.pulls[0].state, "open");
      assertEquals(
        client.requests.slice(before).filter((request) =>
          request.method === "PATCH"
        ),
        [],
      );
    },
  );
}

for (const change of ["target", "head", "PR state"] as const) {
  Deno.test(
    "correct-PR no-op detects late " + change + " changes",
    async () => {
      const client = new ReconciliationClient();
      await client.reconcile([fileA]);
      if (change === "PR state") {
        client.beforePullRead = () => {
          client.pulls[0].state = "closed";
        };
      } else {client.afterRequest = (method, path) => {
          if (method === "GET" && path.includes("/git/commits/")) {
            if (change === "target") {
              client.advanceTarget({ upstream: "advanced" });
            } else client.refs.set("octosmith/reconcile", "competing-head");
          }
        };}
      await assertRejects(
        () => client.reconcile([fileA]),
        Error,
        "changed",
      );
      assertEquals(client.outcomes.map((outcome) => outcome.action), [
        "opened",
      ]);
    },
  );
}

Deno.test("branch changes followed by failed PR metadata produce no updated outcome", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const oldBody = client.pulls[0].body;
  client.failUpdate = true;
  await assertRejects(
    () => client.reconcile([fileA, fileB]),
    Error,
    "body update failed",
  );
  assertEquals(client.files(), { "A.md": "A", "B.md": "B" });
  assertEquals(client.pulls[0].body, oldBody);
  assertEquals(client.lastResult?.pullRequests, undefined);
  assertEquals(client.outcomes.map((outcome) => outcome.action), ["opened"]);
  client.failUpdate = false;
  await client.reconcile([fileA, fileB]);
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
  ]);
});

Deno.test("labels-only updates are validated against current PR state", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.afterRequest = (method, path) => {
    if (method === "POST" && path.endsWith("/labels")) {
      client.pulls[0].state = "closed";
    }
  };
  await assertRejects(
    () => client.reconcile([fileA], { labels: ["automation"] }),
    Error,
    "state changed",
  );
  assertEquals(client.outcomes.map((outcome) => outcome.action), ["opened"]);
  assertEquals(client.lastResult?.pullRequests, undefined);
});

Deno.test("labels-only success emits updated once and the next apply is unchanged", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.failLabels = true;
  await assertRejects(
    () => client.reconcile([fileA], { labels: ["automation"] }),
    Error,
    "Label update failed",
  );
  assertEquals(client.lastResult?.pullRequests, undefined);
  client.failLabels = false;
  await client.reconcile([fileA], { labels: ["automation"] });
  await client.reconcile([fileA], { labels: ["automation"] });
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
  ]);
});

for (const action of ["opened", "updated", "closed"] as const) {
  Deno.test(
    "completed " + action + " survives failed lock cleanup",
    async () => {
      const client = new ReconciliationClient();
      if (action !== "opened") await client.reconcile([fileA]);
      client.failCleanup = true;
      await assertRejects(
        () =>
          client.reconcile(
            action === "closed"
              ? []
              : action === "updated"
              ? [fileA, fileB]
              : [fileA],
          ),
        Error,
        "lock cleanup failed",
      );
      assertEquals(
        client.lastResult?.pullRequests?.map((outcome) => outcome.action),
        [action],
      );
      assertEquals(
        client.refs.get("octosmith/reconcile-lock"),
        client.refs.get("octosmith/reconcile"),
      );
      assertEquals(
        client.pulls[0].state,
        action === "closed" ? "closed" : "open",
      );
    },
  );
}

Deno.test("cleanup failure preserves the original PR failure and emits no lifecycle outcome", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.failUpdate = true;
  client.failCleanup = true;
  await assertRejects(
    () => client.reconcile([fileA, fileB]),
    Error,
    "PR body update failed. Reconciliation lock cleanup failed",
  );
  assertEquals(client.lastResult?.pullRequests, undefined);
  assertEquals(client.pulls[0].state, "open");
  client.failCleanup = false;
  const occupied = client.refs.get("octosmith/reconcile-lock");
  await assertRejects(
    () => client.reconcile([]),
    Error,
    "Atomic reconciliation",
  );
  assertEquals(client.refs.get("octosmith/reconcile-lock"), occupied);
  client.refs.delete("octosmith/reconcile-lock");
  client.failUpdate = false;
  await client.reconcile([fileA, fileB]);
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
  ]);
  assertEquals(client.refs.has("octosmith/reconcile-lock"), false);
});

Deno.test("lost lock ownership aborts PR mutation and never deletes the replacement lock", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.beforePullRead = () =>
    client.refs.set("octosmith/reconcile-lock", "competing-lock");
  const before = client.requests.length;
  await assertRejects(
    () => client.reconcile([]),
    Error,
    "lock changed concurrently",
  );
  assertEquals(client.refs.get("octosmith/reconcile-lock"), "competing-lock");
  assertEquals(client.pulls[0].state, "open");
  assertEquals(client.lastResult?.pullRequests, undefined);
  assertEquals(
    client.requests.slice(before).filter((request) =>
      request.method === "PATCH"
    ),
    [],
  );
});

Deno.test("an overlapping execution cannot overwrite the held reconciliation lock", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.afterRequest = async (_method, path, options) => {
    if (
      path === "/graphql" &&
      (options.body as { variables: { input: { refUpdates: unknown[] } } })
          .variables.input.refUpdates.length === 3
    ) {
      client.afterRequest = undefined;
      const head = client.refs.get("octosmith/reconcile");
      await assertRejects(
        () => client.reconcile([fileA]),
        Error,
        "Atomic reconciliation",
      );
      assertEquals(client.refs.get("octosmith/reconcile"), head);
      assertEquals(client.refs.get("octosmith/reconcile-lock"), head);
    }
  };
  await client.reconcile([fileA, fileB]);
  assertEquals(client.files(), { "A.md": "A", "B.md": "B" });
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
  ]);
});

Deno.test("target movement while reading unchanged files cannot produce an empty-delta success", async () => {
  const client = new ReconciliationClient({ "A.md": "A" });
  client.afterRequest = (method, path) => {
    if (method === "GET" && path.includes("/contents/")) {
      client.advanceTarget({ "A.md": "A", upstream: "new" });
    }
  };
  await assertRejects(() => client.reconcile([fileA]), Error, "target changed");
  assertEquals(client.outcomes, []);
  assertEquals(
    client.requests.filter((request) => request.method !== "GET"),
    [],
  );
});

Deno.test("a no-op candidate refreshes concurrently edited PR metadata without losing human text", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.afterRequest = (method, path) => {
    if (method === "GET" && path.includes("/git/commits/")) {
      client.pulls[0].body = "Human text added during reconciliation";
    }
  };
  await client.reconcile([fileA]);
  assert(
    client.pulls[0].body?.startsWith(
      "Human text added during reconciliation\n\n",
    ),
  );
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
  ]);
});

for (const action of ["opened", "updated", "labels only"] as const) {
  Deno.test(
    "target movement during labels retains only previously completed " +
      action + " actions",
    async () => {
      const client = new ReconciliationClient();
      if (action !== "opened") await client.reconcile([fileA]);
      client.afterRequest = (method, path) => {
        if (method === "POST" && path.endsWith("/labels")) {
          client.advanceTarget({ upstream: "advanced" });
        }
      };
      await assertRejects(
        () =>
          client.reconcile(action === "updated" ? [fileA, fileB] : [fileA], {
            labels: ["automation"],
          }),
        Error,
        "target changed",
      );
      assertEquals(
        client.lastResult?.pullRequests?.map((outcome) => outcome.action) ?? [],
        action === "labels only" ? [] : [action],
      );
    },
  );
}

for (const scenario of ["no PR", "skipped closure", "correct PR"] as const) {
  Deno.test(
    "target advancement during PR discovery rejects " + scenario,
    async () => {
      const client = new ReconciliationClient();
      if (scenario !== "no PR") await client.reconcile([fileA]);
      const outcomes = [...client.outcomes];
      client.afterRequest = (method, path) => {
        if (method === "GET" && path.endsWith("/pulls")) {
          client.advanceTarget({ upstream: "advanced" });
        }
      };
      await assertRejects(
        () =>
          client.reconcile(
            scenario === "correct PR" ? [fileA] : [],
            {},
            scenario !== "skipped closure",
          ),
        Error,
        "target changed",
      );
      assertEquals(client.outcomes, outcomes);
      assertEquals(
        client.pulls[0]?.state,
        scenario === "no PR" ? undefined : "open",
      );
    },
  );
}

Deno.test("file descriptions escape strikethrough and math delimiters", () => {
  const operations = buildFileOperations([], [{ ...fileA, path: "~$file.md" }]);
  const body = managedPullRequestBody(undefined, operations);
  assert(body.includes("<code>&#126;&#36;file.md</code>"));
});

Deno.test("successive authoritative runs retain A, add B, remove A, close, and reopen", async () => {
  const client = new ReconciliationClient({ "unmanaged.txt": "preserve" });
  await client.reconcile([fileA], {
    introduction: "Please review.",
    labels: ["automation"],
  });
  const first = client.refs.get("octosmith/reconcile");
  await client.reconcile([fileA, fileB]);
  assertEquals(client.files(), {
    "A.md": "A",
    "B.md": "B",
    "unmanaged.txt": "preserve",
  });
  assertEquals(client.pulls.length, 1);
  assert(client.pulls[0].body!.includes("A.md"));
  assert(client.pulls[0].body!.includes("B.md"));
  const commit = client.commits.get(client.refs.get("octosmith/reconcile")!)!;
  assertEquals(commit.parents, [{ sha: client.refs.get("main") }]);
  assert(!commit.parents.some((parent) => parent.sha === first));
  await client.reconcile([fileB]);
  assertEquals(client.files(), { "B.md": "B", "unmanaged.txt": "preserve" });
  assert(!client.pulls[0].body!.includes("A.md"));
  await client.reconcile([]);
  assertEquals(client.files(), { "unmanaged.txt": "preserve" });
  assertEquals(client.pulls[0].state, "closed");
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
    "updated",
    "closed",
  ]);
  assertEquals(client.outcomes.at(-1), {
    repository: "sample",
    number: 1,
    url: client.pulls[0].html_url,
    action: "closed",
    reason: "no_differences",
  });
  const before = client.requests.length;
  await client.reconcile([]);
  assert(
    client.requests.slice(before).every((request) => request.method === "GET"),
  );
  await client.reconcile([fileA]);
  assertEquals(client.pulls.length, 2);
  assertEquals(client.outcomes.at(-1)?.action, "opened");
});

Deno.test("identical reconciliation has no mutations or false updated outcome", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA], { labels: ["automation"] });
  const before = client.requests.length;
  await client.reconcile([fileA], { labels: ["automation"] });
  assert(
    client.requests.slice(before).every((request) => request.method === "GET"),
  );
  assertEquals(client.outcomes.length, 1);
});

Deno.test("new target commits are the only parent and still-desired unmerged files survive", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.advanceTarget({ "upstream.txt": "new" });
  await client.reconcile([fileA, fileB]);
  assertEquals(client.files(), {
    "A.md": "A",
    "B.md": "B",
    "upstream.txt": "new",
  });
  assertEquals(
    client.commits.get(client.refs.get("octosmith/reconcile")!)!.parents,
    [{ sha: client.refs.get("main") }],
  );
});

Deno.test("mixed operations accurately describe the resulting delta and preserve exists files", async () => {
  const client = new ReconciliationClient({
    "update.md": "before",
    "remove.md": "obsolete",
    "exists.md": "preserve",
    "line-endings.md": "same\r\n",
  });
  await client.reconcile([
    fileA,
    { path: "update.md", ensure: "exact", content: "after" },
    { path: "remove.md", ensure: "absent" },
    { path: "exists.md", ensure: "exists", content: "ignored" },
    { path: "line-endings.md", ensure: "exact", content: "same\n" },
  ]);
  assertEquals(client.files(), {
    "A.md": "A",
    "exists.md": "preserve",
    "line-endings.md": "same\r\n",
    "update.md": "after",
  });
  assert(client.pulls[0].body!.includes("<code>A.md</code> - create"));
  assert(client.pulls[0].body!.includes("<code>remove.md</code> - remove"));
  assert(client.pulls[0].body!.includes("<code>update.md</code> - update"));
  assert(!client.pulls[0].body!.includes("exists.md"));
});

Deno.test("human body edits and introduction survive updates with or without markers", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA], { introduction: "Original introduction" });
  client.pulls[0].body = client.pulls[0].body!.replace(
    "Original introduction",
    "Human introduction",
  ) + "\n\nHuman footer";
  await client.reconcile([fileA, fileB], {
    introduction: "Changed configuration",
  });
  assert(client.pulls[0].body!.startsWith("Human introduction\n\n"));
  assert(client.pulls[0].body!.endsWith("\n\nHuman footer"));
  client.pulls[0].body = "Entirely handwritten";
  await client.reconcile([fileB]);
  assert(client.pulls[0].body!.startsWith("Entirely handwritten\n\n"));
  assertEquals(
    client.pulls[0].body!.split("<!-- octosmith:files:start -->").length,
    2,
  );
});

Deno.test("body renderer escapes Markdown-sensitive paths, sorts and deduplicates", () => {
  const special = { ...fileA, path: "z/<script>&`[x]*\\\n.md" };
  const operations = buildFileOperations([], [special, fileA]);
  const body = managedPullRequestBody(undefined, [
    ...operations,
    operations[0],
  ]);
  assert(!body.includes("<script>"));
  assert(
    body.includes("&#60;script&#62;&#38;&#96;&#91;x&#93;&#42;&#92;&#10;.md"),
  );
  assert(body.indexOf("A.md") < body.indexOf("z/"));
  assertEquals(body.split(" - create").length, 3);
  assertEquals(managedPullRequestBody(body, operations), body);
  for (
    const malformed of [
      "<!-- octosmith:files:start -->",
      "<!-- octosmith:files:end -->",
      "<!-- octosmith:files:end --><!-- octosmith:files:start -->",
      body + body,
      "<!-- octosmith:files:broken -->",
    ]
  ) {
    assertThrows(
      () => managedPullRequestBody(malformed, operations),
      Error,
      "markers",
    );
  }
});

Deno.test("invalid body markers fail before branch mutation or closure", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.pulls[0].body += "<!-- octosmith:files:start -->";
  const head = client.refs.get("octosmith/reconcile");
  await assertRejects(() => client.reconcile([]), Error, "markers");
  assertEquals(client.refs.get("octosmith/reconcile"), head);
  assertEquals(client.pulls[0].state, "open");
});

Deno.test("stale snapshots and incomplete operation lists cannot close a PR", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const snapshot = client.snapshot([]);
  client.advanceTarget({ "unrelated.txt": "changed" });
  const options = {
    client,
    owner: "acme",
    repository: "sample",
    snapshot,
    operations: [],
    settings: {},
    commitMessage: "Sync",
    allowClosure: true,
    onPullRequest: () => {},
  };
  await assertRejects(
    () => reconcileFilePullRequest(options),
    Error,
    "target changed",
  );
  await assertRejects(
    () =>
      reconcileFilePullRequest({
        ...options,
        snapshot: client.snapshot([fileA]),
      }),
    Error,
    "complete desired-state delta",
  );
  assertEquals(client.pulls[0].state, "open");
  assertEquals(client.outcomes.length, 1);
});

for (const conflict of ["create", "branch", "target", "after-reset"] as const) {
  Deno.test(
    "concurrent " + conflict + " changes fail without overwriting or closure",
    async () => {
      const client = new ReconciliationClient();
      if (conflict !== "create") await client.reconcile([fileA]);
      const compete = () => {
        if (conflict === "target") client.advanceTarget({ "upstream": "new" });
        else client.refs.set("octosmith/reconcile", "competing-sha");
      };
      if (conflict === "after-reset") client.afterAtomic = compete;
      else client.beforeAtomic = compete;
      await assertRejects(
        () => client.reconcile(conflict === "create" ? [fileA] : []),
        Error,
        conflict === "after-reset"
          ? "changed concurrently"
          : "Atomic reconciliation",
      );
      if (conflict !== "target") {
        assertEquals(client.refs.get("octosmith/reconcile"), "competing-sha");
      }
      assertEquals(
        client.pulls[0]?.state,
        conflict === "create" ? undefined : "open",
      );
      assert(!client.outcomes.some((outcome) => outcome.action === "closed"));
    },
  );
}

Deno.test("unowned branches and PRs with a different target are never overwritten or closed", async () => {
  const client = new ReconciliationClient();
  client.refs.set("octosmith/reconcile", client.refs.get("main")!);
  await assertRejects(() => client.reconcile([fileA]), Error, "ownership");
  client.refs.delete("octosmith/reconcile");
  await client.reconcile([fileA]);
  client.pulls[0].base.ref = "unrelated";
  await assertRejects(() => client.reconcile([]), Error, "ownership");
  assertEquals(client.pulls[0].state, "open");
});

Deno.test("manual reserved-branch commits are discarded, human descriptions are retained", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const old = client.refs.get("octosmith/reconcile")!;
  client.commits.set("manual", {
    sha: "manual",
    message: "Manual commit",
    tree: { sha: client.storeTree({ ...client.files(), "manual": "discard" }) },
    parents: [{ sha: old }],
  });
  client.refs.set("octosmith/reconcile", "manual");
  client.pulls[0].body += "\nHuman note";
  await client.reconcile([fileA, fileB]);
  assertEquals(client.files(), { "A.md": "A", "B.md": "B" });
  assert(client.pulls[0].body!.endsWith("Human note"));
});

Deno.test("skipped reconciliation and failed closure emit no closed outcome", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const head = client.refs.get("octosmith/reconcile");
  await client.reconcile([], {}, false);
  assertEquals(client.refs.get("octosmith/reconcile"), head);
  client.failClose = true;
  await assertRejects(() => client.reconcile([]), Error, "closure failed");
  assertEquals(client.pulls[0].state, "open");
  assertEquals(client.outcomes.length, 1);
  client.failClose = false;
  await client.reconcile([]);
  assertEquals(client.outcomes.at(-1)?.action, "closed");
});

Deno.test("concurrently closed PR is not reopened and produces no closure outcome", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  client.beforePullRead = () => {
    client.pulls[0].state = "closed";
  };
  await assertRejects(() => client.reconcile([]), Error, "state changed");
  assertEquals(client.outcomes.length, 1);
});

Deno.test("successful opened and updated outcomes survive later label failures", async () => {
  const client = new ReconciliationClient();
  client.failLabels = true;
  await assertRejects(
    () => client.reconcile([fileA], { labels: ["automation"] }),
    Error,
    "Label update failed",
  );
  assertEquals(client.outcomes.map((outcome) => outcome.action), ["opened"]);
  await assertRejects(
    () => client.reconcile([fileA, fileB], { labels: ["automation"] }),
    Error,
    "Label update failed",
  );
  assertEquals(client.outcomes.map((outcome) => outcome.action), [
    "opened",
    "updated",
  ]);
});

Deno.test("PR creation failure emits no lifecycle outcome and can be retried", async () => {
  const client = new ReconciliationClient();
  client.failCreate = true;
  await assertRejects(
    () => client.reconcile([fileA]),
    Error,
    "creation failed",
  );
  assertEquals(client.outcomes, []);
  client.failCreate = false;
  await client.reconcile([fileA]);
  assertEquals(client.outcomes.map((outcome) => outcome.action), ["opened"]);
});

Deno.test("an occupied lock refuses mutation and is never removed by a competing run", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const head = client.refs.get("octosmith/reconcile");
  client.refs.set("octosmith/reconcile-lock", "competing-lock");
  await assertRejects(
    () => client.reconcile([]),
    Error,
    "lock may have changed",
  );
  assertEquals(client.refs.get("octosmith/reconcile"), head);
  assertEquals(client.refs.get("octosmith/reconcile-lock"), "competing-lock");
  assertEquals(client.pulls[0].state, "open");
});

Deno.test("apply without a complete snapshot cannot close an existing PR", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const result = await applyPlan(
    new GitHubRepositoryMutationSink({
      client,
      owner: "acme",
      secretValue: () => "unused",
      fileChanges: { mode: "pull_request" },
    }),
    { repository: "sample", operations: [] },
  );
  assert(result.error?.includes("complete managed-file snapshot"));
  assertEquals(client.pulls[0].state, "open");
  assertEquals(result.pullRequests, undefined);
});

Deno.test("amended trees with unchanged commit messages are not mistaken for no-op", async () => {
  const client = new ReconciliationClient();
  await client.reconcile([fileA]);
  const original = client.commits.get(client.refs.get("octosmith/reconcile")!)!;
  client.commits.set("amended", {
    ...original,
    sha: "amended",
    tree: { sha: client.storeTree({ "manual": "unexpected" }) },
  });
  client.refs.set("octosmith/reconcile", "amended");
  await client.reconcile([fileA]);
  assertEquals(client.files(), { "A.md": "A" });
  assertEquals(client.outcomes.at(-1)?.action, "updated");
});

Deno.test("the target branch cannot be used as the reconciliation branch", async () => {
  const client = new ReconciliationClient();
  await assertRejects(
    () =>
      reconcileFilePullRequest({
        client,
        owner: "acme",
        repository: "sample",
        snapshot: { ...client.snapshot([]), branch: "octosmith/reconcile" },
        operations: [],
        settings: {},
        commitMessage: "Sync",
        allowClosure: true,
        onPullRequest: () => {},
      }),
    Error,
    "must not match target branch",
  );
  assertEquals(client.requests, []);
});

Deno.test("GitHub response bodies cannot leak managed content through apply errors", async () => {
  const client = new ReconciliationClient();
  const rejecting: GitHubClient = {
    get: client.get.bind(client),
    request: () => {
      throw new GitHubRequestError(
        422,
        "Invalid",
        "managed-content-must-not-leak",
      );
    },
  };
  const applied = await applyPlan(
    new GitHubRepositoryMutationSink({
      client: rejecting,
      owner: "acme",
      secretValue: () => "unused",
      fileChanges: { mode: "pull_request" },
    }),
    {
      repository: "sample",
      managedFiles: client.snapshot([fileA]),
      operations: client.operations([fileA]),
    },
  );
  assertEquals(
    applied.operations[0].error,
    "GitHub managed-file reconciliation failed (HTTP 422)",
  );
  assert(!JSON.stringify(applied).includes("managed-content-must-not-leak"));
});

async function withCli(
  client: ReconciliationClient,
  test: (options: {
    root: string;
    configure: (
      files: readonly DesiredFile[],
      labels?: readonly string[],
    ) => Promise<void>;
    run: (
      args: readonly string[],
    ) => Promise<
      {
        code: number;
        report: Record<string, unknown>;
        events: { type: string; data: unknown }[];
      }
    >;
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  const runtime = createGitHubRuntime({
    token: "test-token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const options = {
        query: Object.fromEntries(url.searchParams),
        ...(init?.body && { body: JSON.parse(String(init.body)) }),
        allowNotFound: true,
      };
      try {
        const response = await client.request(method, url.pathname, options);
        return response === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json(response);
      } catch {
        return Response.json({ message: "Simulated API failure" }, {
          status: 500,
        });
      }
    },
  });
  try {
    await Deno.mkdir(root + "/templates");
    await Deno.mkdir(root + "/files");
    await test({
      root,
      configure: async (files, labels = []) => {
        await Deno.writeTextFile(
          root + "/octosmith.yml",
          JSON.stringify({
            version: 1,
            organization: "acme",
            repositories: {
              scope: { include: "all" },
              file_changes: {
                mode: "pull_request",
                pull_request: {
                  introduction: "Central configuration.",
                  labels,
                },
              },
            },
          }),
        );
        const desired: Record<string, unknown> = {};
        for (const [index, file] of files.entries()) {
          if (file.ensure === "absent") {
            desired[file.path] = { ensure: "absent" };
          } else {
            const source = "files/" + index + ".txt";
            await Deno.writeTextFile(root + "/" + source, file.content);
            desired[file.path] = { ensure: file.ensure, source };
          }
        }
        await Deno.writeTextFile(
          root + "/templates/code.yml",
          JSON.stringify({
            version: 1,
            kind: "repository",
            match: { include: "all" },
            repository: { files: desired },
          }),
        );
      },
      run: async (args) => {
        const output: string[] = [];
        const errors: string[] = [];
        const eventsPath = root + "/events.ndjson";
        const code = await main([
          ...args,
          "--path",
          root,
          "--format",
          "json",
          "--events-output",
          eventsPath,
        ], {
          runtime,
          write: (value) => output.push(value),
          writeError: (value) => errors.push(value),
        });
        assert(output.length > 0, errors.join("\n"));
        const lines = (await Deno.readTextFile(eventsPath)).trim();
        return {
          code,
          report: JSON.parse(output.join("\n")),
          events: lines
            ? lines.split("\n").map((line) => JSON.parse(line))
            : [],
        };
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("CLI saved zero-operation plan closes a PR and streams canonical lifecycle JSON", async () => {
  const client = new ReconciliationClient();
  await withCli(client, async ({ root, configure, run }) => {
    await configure([fileA]);
    const planned = await run(["plan"]);
    assertEquals(planned.code, 0);
    assertEquals(planned.report.pullRequests, undefined);
    assertEquals(planned.events.map((event) => event.type), [
      "resource.planned",
    ]);
    const opened = await run(["apply"]);
    assertEquals(opened.code, 0);
    assertEquals(opened.events.map((event) => event.type), [
      "pull_request.opened",
      "resource.applied",
    ]);
    assertEquals(opened.report.pullRequests, [opened.events[0].data]);
    assert(!JSON.stringify(opened.report).includes("file.content"));
    await configure([fileA, fileB]);
    const updated = await run(["apply"]);
    assertEquals(updated.code, 0);
    assertEquals(updated.events.map((event) => event.type), [
      "pull_request.updated",
      "resource.applied",
    ]);
    assertEquals(updated.report.pullRequests, [updated.events[0].data]);
    const noop = await run(["apply"]);
    assertEquals(noop.code, 0);
    assertEquals(noop.report.pullRequests, []);
    assertEquals(noop.events.map((event) => event.type), ["resource.applied"]);
    await configure([]);
    const plan = root + "/plan.json";
    const cleanupPlan = await run(["plan", "--out", plan]);
    assertEquals(cleanupPlan.code, 0);
    const artifact = JSON.parse(await Deno.readTextFile(plan));
    assertEquals(artifact.resources[0].operations, []);
    assertEquals(artifact.resources[0].managedFiles, client.snapshot([]));
    assertEquals(Object.keys(artifact.resources[0]).sort(), [
      "evaluations",
      "managedFiles",
      "name",
      "operations",
      "state",
      "template",
      "type",
    ]);
    const closed = await run(["apply", "--plan", plan]);
    assertEquals(closed.code, 0);
    assertEquals(closed.events.map((event) => event.type), [
      "pull_request.closed",
      "resource.applied",
    ]);
    assertEquals(closed.report.pullRequests, [closed.events[0].data]);
    assertEquals(closed.events[0].data, {
      repository: "sample",
      number: 1,
      url: client.pulls[0].html_url,
      action: "closed",
      reason: "no_differences",
    });
    assertEquals(client.pulls[0].state, "closed");
  });
});

Deno.test("CLI persisted plans reject moved targets, incomplete snapshots and changed introductions", async () => {
  const client = new ReconciliationClient();
  await withCli(client, async ({ root, configure, run }) => {
    await configure([fileA]);
    assertEquals((await run(["apply"])).code, 0);
    await configure([]);
    const plan = root + "/plan.json";
    assertEquals((await run(["plan", "--out", plan])).code, 0);
    const serialized = await Deno.readTextFile(plan);
    const base = client.refs.get("main")!;
    client.advanceTarget({ "unmanaged": "target advanced" });
    const before = client.requests.length;
    const stale = await run(["apply", "--plan", plan]);
    assertEquals(stale.code, 1);
    assertEquals(stale.events, []);
    assert(
      client.requests.slice(before).every((request) =>
        request.method === "GET"
      ),
    );
    client.refs.set("main", base);
    const incomplete = JSON.parse(serialized);
    delete incomplete.resources[0].managedFiles;
    await Deno.writeTextFile(plan, JSON.stringify(incomplete));
    assertEquals((await run(["apply", "--plan", plan])).code, 1);
    await Deno.writeTextFile(plan, serialized);
    const configuration = JSON.parse(
      await Deno.readTextFile(root + "/octosmith.yml"),
    );
    configuration.repositories.file_changes.pull_request.introduction =
      "Changed introduction";
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      JSON.stringify(configuration),
    );
    assertEquals((await run(["apply", "--plan", plan])).code, 1);
    assertEquals(client.pulls[0].state, "open");
  });
});

for (
  const failure of ["body", "post-branch target", "labels", "cleanup"] as const
) {
  Deno.test(
    "CLI reports only completed PR actions on " + failure + " failure",
    async () => {
      const client = new ReconciliationClient();
      await withCli(client, async ({ configure, run }) => {
        await configure([fileA]);
        assertEquals((await run(["apply"])).code, 0);
        await configure([fileA, fileB], ["automation"]);
        if (failure === "body") client.failUpdate = true;
        if (failure === "post-branch target") {
          client.afterAtomic = () => client.advanceTarget({ upstream: "new" });
        }
        if (failure === "labels") client.failLabels = true;
        if (failure === "cleanup") client.failCleanup = true;
        const applied = await run(["apply"]);
        assertEquals(applied.code, 1);
        const completed = failure === "labels" || failure === "cleanup";
        assertEquals(
          applied.events.map((event) => event.type),
          completed
            ? ["pull_request.updated", "resource.applied"]
            : ["resource.applied"],
        );
        assertEquals(
          applied.report.pullRequests,
          completed ? [applied.events[0].data] : [],
        );
        assertEquals(
          (applied.report.repositories as { status: string }[])[0].status,
          completed ? "partially-applied" : "failed",
        );
      });
    },
  );
}

Deno.test("CLI retains a validated closure when releasing its lock fails", async () => {
  const client = new ReconciliationClient();
  await withCli(client, async ({ configure, run }) => {
    await configure([fileA]);
    assertEquals((await run(["apply"])).code, 0);
    await configure([]);
    client.failCleanup = true;
    const applied = await run(["apply"]);
    assertEquals(applied.code, 1);
    assertEquals(applied.events.map((event) => event.type), [
      "pull_request.closed",
      "resource.applied",
    ]);
    assertEquals(applied.report.pullRequests, [applied.events[0].data]);
    const report =
      (applied.report.repositories as { status: string; error: string }[])[0];
    assertEquals(report.status, "partially-applied");
    assert(report.error.includes("lock cleanup failed"));
  });
});

Deno.test("CLI retains successful lifecycle events and JSON on a later GitHub failure", async () => {
  const client = new ReconciliationClient();
  client.failLabels = true;
  await withCli(client, async ({ configure, run }) => {
    await configure([fileA], ["automation"]);
    const applied = await run(["apply"]);
    assertEquals(applied.code, 1);
    assertEquals(applied.events.map((event) => event.type), [
      "pull_request.opened",
      "resource.applied",
    ]);
    assertEquals(applied.report.pullRequests, [applied.events[0].data]);
    assertEquals(
      (applied.report.repositories as { status: string }[])[0].status,
      "partially-applied",
    );
  });
});
