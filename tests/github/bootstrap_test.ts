import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  applyPlan,
  assertBootstrapFileOwned,
  BOOTSTRAP_FILE_CONTENT,
  BOOTSTRAP_FILE_END_MARKER,
  BOOTSTRAP_FILE_MARKER,
  BOOTSTRAP_FILE_PATH,
  buildApplyEvaluations,
  buildPlan,
  createPersistedPlanArtifact,
  type DesiredFile,
  type DesiredState,
  fileExecutionBranch,
  type GitHubClient,
  GitHubRepositoryBootstrap,
  GitHubRepositoryMutationSink,
  GitHubRepositoryStateSource,
  GitHubRequestError,
  type GitHubRequestOptions,
  type LoadedConfiguration,
  type Operation,
  projectOwnedCurrentState,
  readCurrentState,
  resolveDesiredState,
} from "@octosmith/octosmith";
import { createGitHubRuntime, main } from "../../packages/cli/mod.ts";
import { applyPersistedPlan } from "../../packages/cli/persisted.ts";
import { currentRepositorySettings, currentState } from "../plan/fixtures.ts";

type Tree = Record<string, string>;
interface Commit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

class BootstrapClient implements GitHubClient {
  defaultBranch = "master";
  readonly refs = new Map<string, string>();
  readonly trees = new Map<string, Tree>();
  readonly commits = new Map<string, Commit>();
  readonly blobs = new Map<string, string>();
  readonly requests: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  failDefault = false;
  loseContentsResponse = false;
  loseRefResponse = false;
  rejectContents = false;
  ignoreDefault = false;
  beforeContents?: () => void;
  next = 1;

  root(branch: string, files: Tree): string {
    const commit = this.commit(files, []);
    this.refs.set(branch, commit.sha);
    return commit.sha;
  }
  commit(files: Tree, parents: { sha: string }[]): Commit {
    const sha = "commit-" + this.next++;
    const tree = "tree-" + this.next++;
    this.trees.set(tree, { ...files });
    const commit = { sha, tree: { sha: tree }, parents };
    this.commits.set(sha, commit);
    return commit;
  }
  files(ref = this.defaultBranch): Tree {
    const sha = this.refs.get(ref) ?? ref;
    return this.trees.get(this.commits.get(sha)!.tree.sha)!;
  }
  get<T>(path: string, query?: GitHubRequestOptions["query"]): Promise<T> {
    return this.request("GET", path, { query });
  }
  request<T>(
    method: string,
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    this.requests.push({ method, path, body });
    const result = this.respond(method, path, options, body);
    return Promise.resolve(structuredClone(result) as T);
  }
  respond(
    method: string,
    path: string,
    options: GitHubRequestOptions,
    body: Record<string, unknown>,
  ): unknown {
    const repo = "/repos/acme/sample";
    if (method === "GET") {
      if (path === "/users/acme") {
        return { login: "acme", type: "Organization" };
      }
      if (path === repo) {
        return {
          name: "sample",
          default_branch: this.defaultBranch,
          visibility: "private",
        };
      }
      if (path === repo + "/branches") {
        return [...this.refs].map(([name, sha]) => ({ name, commit: { sha } }));
      }
      if (path.includes("/git/ref/heads/")) {
        const branch = path.split("/git/ref/heads/")[1].split("/").map(
          decodeURIComponent,
        ).join("/");
        if (this.refs.size === 0) {
          throw new GitHubRequestError(
            409,
            "Conflict",
            JSON.stringify({ message: "Git Repository is empty." }),
          );
        }
        const sha = this.refs.get(branch);
        if (!sha && !options.allowNotFound) {
          throw new GitHubRequestError(404, "Not Found", "Not Found");
        }
        return sha ? { object: { sha } } : undefined;
      }
      if (path.includes("/contents/")) {
        const name = decodeURIComponent(path.split("/contents/")[1]);
        const content =
          this.files(String(options.query?.ref ?? this.defaultBranch))[name];
        return content === undefined ? undefined : {
          type: "file",
          encoding: "base64",
          content: btoa(content),
          sha: "blob:" + content,
        };
      }
      if (path.includes("/git/commits/")) {
        return this.commits.get(path.split("/git/commits/")[1]);
      }
      if (path.includes("/git/trees/")) {
        const files = this.trees.get(path.split("/git/trees/")[1])!;
        return {
          truncated: false,
          tree: Object.keys(files).map((name) => ({
            path: name,
            type: "blob",
          })),
        };
      }
      if (path.endsWith("/rulesets")) return [];
      if (path.endsWith("/rulesets/1")) {
        return {
          name: "protect",
          target: "push",
          enforcement: "disabled",
          rules: [],
          bypass_actors: [],
        };
      }
    }
    if (
      method === "PUT" && path === repo + "/contents/" + BOOTSTRAP_FILE_PATH
    ) {
      if (this.rejectContents) {
        throw new GitHubRequestError(
          403,
          "Forbidden",
          "GH013: inherited policy blocks initialization",
        );
      }
      this.beforeContents?.();
      const branch = String(body.branch);
      if (this.refs.size && !this.refs.has(branch)) {
        throw new GitHubRequestError(404, "Not Found", "Branch not found");
      }
      const previous = this.refs.get(branch);
      const files = previous ? this.files(branch) : {};
      if (files[BOOTSTRAP_FILE_PATH] !== undefined) {
        throw new GitHubRequestError(
          422,
          "Unprocessable Entity",
          "sha was not supplied",
        );
      }
      const commit = this.commit({
        ...files,
        [BOOTSTRAP_FILE_PATH]: atob(String(body.content)),
      }, previous ? [{ sha: previous }] : []);
      this.refs.set(branch, commit.sha);
      if (this.loseContentsResponse) {
        this.loseContentsResponse = false;
        throw new Error("lost Contents response");
      }
      return { content: { path: BOOTSTRAP_FILE_PATH }, commit };
    }
    if (method === "PATCH" && path === repo) {
      if (this.failDefault) {
        throw new GitHubRequestError(
          403,
          "Forbidden",
          "Default branch update denied",
        );
      }
      if (body.default_branch && !this.ignoreDefault) {
        this.defaultBranch = String(body.default_branch);
      }
      return { default_branch: this.defaultBranch };
    }
    if (method === "POST" && path.endsWith("/git/blobs")) {
      const sha = "blob:" + String(body.content);
      this.blobs.set(sha, String(body.content));
      return { sha };
    }
    if (method === "POST" && path.endsWith("/git/trees")) {
      const files = { ...this.trees.get(String(body.base_tree)) };
      for (const entry of body.tree as { path: string; sha: string | null }[]) {
        if (entry.sha === null) delete files[entry.path];
        else files[entry.path] = this.blobs.get(entry.sha)!;
      }
      const sha = "tree-" + this.next++;
      this.trees.set(sha, files);
      return { sha };
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      return this.commit(
        this.trees.get(String(body.tree))!,
        (body.parents as string[]).map((sha) => ({ sha })),
      );
    }
    if (method === "PATCH" && path.includes("/git/refs/heads/")) {
      this.refs.set(path.split("/git/refs/heads/")[1], String(body.sha));
      if (this.loseRefResponse) {
        this.loseRefResponse = false;
        throw new Error("lost commit response");
      }
      return { object: { sha: body.sha } };
    }
    if ((method === "POST" || method === "PUT") && path.includes("/rulesets")) {
      return { id: 1 };
    }
    throw new Error("Unexpected API request: " + method + " " + path);
  }
}

const desiredFiles: readonly DesiredFile[] = [
  { path: "managed.txt", ensure: "exact", content: "managed" },
  { path: "seed.txt", ensure: "exists", content: "seed" },
  { path: "absent.txt", ensure: "absent" },
];
function sink(client: BootstrapClient) {
  return new GitHubRepositoryMutationSink({
    client,
    owner: "acme",
    secretValue: () => "unused",
    fileChanges: { mode: "direct" },
    bootstrap: new GitHubRepositoryBootstrap(client, "acme"),
  });
}
function source(client: BootstrapClient) {
  return new GitHubRepositoryStateSource(client, "acme");
}
function contentsWrites(client: BootstrapClient) {
  return client.requests.filter((request) =>
    request.method === "PUT" && request.path.includes("/contents/")
  );
}

for (const branch of ["main", "develop", "feature/initial"]) {
  Deno.test(`Contents API creates the first commit directly on ${branch} and completes default selection`, async () => {
    const client = new BootstrapClient();
    await new GitHubRepositoryBootstrap(client, "acme").initialize(
      "sample",
      branch,
    );
    assertEquals(contentsWrites(client).map((request) => request.body), [{
      message: "Octosmith: initialize repository",
      branch,
      content: btoa(BOOTSTRAP_FILE_CONTENT),
    }]);
    assertEquals(client.files(branch), {
      [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT,
    });
    assertEquals(client.defaultBranch, branch);
    assertEquals(client.commits.size, 1);
    assertEquals([...client.commits.values()][0].parents, []);
    assert(
      !client.requests.some((request) => request.path.endsWith("/git/refs")),
    );
    await assertRejects(
      () =>
        new GitHubRepositoryBootstrap(client, "acme").initialize(
          "sample",
          branch,
        ),
      Error,
      "acquired Git history",
    );
  });
}

Deno.test("reserved ownership is explicit and survives explanatory wording changes", () => {
  assertEquals(BOOTSTRAP_FILE_PATH, ".github/.octosmith-bootstrap");
  const file = {
    path: BOOTSTRAP_FILE_PATH,
    sha: "test",
    content: BOOTSTRAP_FILE_CONTENT.replace(
      "Until then, it is safe to leave in place.",
      "Updated explanatory wording.",
    ),
  };
  assertBootstrapFileOwned(file);
  for (
    const content of [
      "user content",
      BOOTSTRAP_FILE_MARKER,
      BOOTSTRAP_FILE_CONTENT.replace(BOOTSTRAP_FILE_END_MARKER, ""),
      "prefix\n" + BOOTSTRAP_FILE_CONTENT,
    ]
  ) {
    assertThrows(
      () => assertBootstrapFileOwned({ ...file, content }),
      Error,
      "conflict",
    );
  }
});

Deno.test("retaining both ownership markers makes completely replaced interior text disposable", async () => {
  const content = BOOTSTRAP_FILE_MARKER +
    "\nCompletely repurposed human notes.\n" + BOOTSTRAP_FILE_END_MARKER + "\n";
  assertBootstrapFileOwned({
    path: BOOTSTRAP_FILE_PATH,
    content,
    sha: "reviewed",
  });
  const client = new BootstrapClient();
  client.defaultBranch = "main";
  client.root("main", {
    [BOOTSTRAP_FILE_PATH]: content,
    "user.txt": "preserved",
  });
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    fileDelivery: "direct",
  };
  const result = await applyPlan(
    sink(client),
    buildPlan(await readCurrentState(source(client), desired), desired),
  );
  assert(result.operations.every((item) => item.status === "applied"));
  assertEquals(client.files(), { "user.txt": "preserved" });
});

for (const marker of [BOOTSTRAP_FILE_MARKER, BOOTSTRAP_FILE_END_MARKER]) {
  Deno.test(`removing ownership boundary ${marker} preserves repurposed content`, async () => {
    const content =
      (BOOTSTRAP_FILE_MARKER + "\nUser notes\n" + BOOTSTRAP_FILE_END_MARKER +
        "\n").replace(marker, "");
    const client = new BootstrapClient();
    client.defaultBranch = "main";
    client.root("main", { [BOOTSTRAP_FILE_PATH]: content });
    await assertRejects(
      () =>
        readCurrentState(source(client), {
          repository: "sample",
          template: "code",
        }),
      Error,
      "conflict",
    );
    assertEquals(client.files()[BOOTSTRAP_FILE_PATH], content);
    assertEquals(
      client.requests.filter((request) => request.method !== "GET"),
      [],
    );
  });
}

Deno.test("templates cannot declare the reserved path even for deletion", async () => {
  const desired = {
    repository: "sample",
    template: "code",
    files: [{ path: BOOTSTRAP_FILE_PATH, ensure: "absent" as const }],
  };
  assertThrows(
    () => buildPlan(currentState(), desired),
    Error,
    "managed exclusively",
  );
  await assertRejects(
    () =>
      resolveDesiredState(
        {
          root: ".",
          configuration: {
            version: 1,
            organization: "acme",
            repositories: { scope: { include: "all" } },
          },
          templates: {
            code: {
              version: 1,
              kind: "repository",
              match: { include: "all" },
              repository: {
                files: { [BOOTSTRAP_FILE_PATH]: { ensure: "absent" } },
              },
            },
          },
        },
        { name: "sample", teams: [], properties: {} },
        () => "unused",
      ),
    Error,
    "managed exclusively",
  );
});

for (const failure of ["failDefault", "loseContentsResponse"] as const) {
  Deno.test(`retry completes partial API bootstrap after ${failure} without another initial commit`, async () => {
    const client = new BootstrapClient();
    client[failure] = true;
    await assertRejects(() =>
      new GitHubRepositoryBootstrap(client, "acme").initialize("sample", "main")
    );
    client[failure] = false;
    const desired: DesiredState = {
      repository: "sample",
      template: "code",
      fileDelivery: "direct",
    };
    const current = await readCurrentState(source(client), desired);
    assert(current.bootstrapBranchPending);
    const plan = buildPlan(current, desired);
    assertEquals(plan.operations[0], {
      type: "initialize-repository",
      branch: "main",
      expectedHead: client.refs.get("main"),
    });
    const result = await applyPlan(sink(client), plan);
    assert(result.operations.every((item) => item.status === "applied"));
    assertEquals(contentsWrites(client).length, 1);
    assertEquals(client.defaultBranch, "main");
    assertEquals(client.files(), {});
    assertEquals(
      buildPlan(await readCurrentState(source(client), desired), desired)
        .operations,
      [],
    );
  });
}

for (const files of [[], desiredFiles]) {
  Deno.test(`direct mode cleans bootstrap and delivers all files in one subsequent commit (${files.length})`, async () => {
    const client = new BootstrapClient();
    const desired: DesiredState = {
      repository: "sample",
      template: "code",
      fileDelivery: "direct",
      files,
    };
    const before = await readCurrentState(source(client), desired);
    const plan = buildPlan(before, desired);
    const result = await applyPlan(sink(client), plan);
    assert(result.operations.every((item) => item.status === "applied"));
    assertEquals(client.commits.size, 2);
    assertEquals(
      client.files(),
      files.length ? { "managed.txt": "managed", "seed.txt": "seed" } : {},
    );
    assertEquals(contentsWrites(client).length, 1);
    const treeWrite = client.requests.find((request) =>
      request.method === "POST" && request.path.endsWith("/git/trees")
    )!;
    if (files.length) {
      assertEquals((treeWrite.body.tree as unknown[]).length, 3);
    } else {
      assertEquals(treeWrite, undefined);
      assertEquals(
        client.requests.find((request) =>
          request.method === "POST" && request.path.endsWith("/git/commits")
        )?.body.tree,
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      );
    }
    assertEquals(
      buildPlan(await readCurrentState(source(client), desired), desired)
        .operations,
      [],
    );
    assert(
      JSON.stringify(
        projectOwnedCurrentState(before, desired, plan.operations),
      ) !==
        JSON.stringify(
          projectOwnedCurrentState(
            await readCurrentState(source(client), desired),
            desired,
            plan.operations,
          ),
        ),
    );
  });
}

for (const sharedHead of [false, true]) {
  Deno.test(`standalone direct cleanup uses its snapshot branch instead of metadata (shared head: ${sharedHead})`, async () => {
    const client = new BootstrapClient();
    client.defaultBranch = "main";
    const targetHead = client.root("develop", {
      [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT,
      "user.txt": "preserved",
    });
    const defaultHead = sharedHead ? targetHead : client.root("main", {
      [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT,
      "default.txt": "untouched",
    });
    client.refs.set("main", defaultHead);
    const current = currentState({
      settings: currentRepositorySettings({ defaultBranch: "develop" }),
      filesBranch: "develop",
      filesBaseSha: targetHead,
      bootstrapFile: {
        path: BOOTSTRAP_FILE_PATH,
        content: BOOTSTRAP_FILE_CONTENT,
        sha: "blob:" + BOOTSTRAP_FILE_CONTENT,
      },
    });
    const desired: DesiredState = {
      repository: "sample",
      template: "code",
      fileDelivery: "direct",
    };
    const result = await applyPlan(sink(client), buildPlan(current, desired));
    assert(result.operations.every((item) => item.status === "applied"));
    assertEquals(client.refs.get("main"), defaultHead);
    assertEquals(client.defaultBranch, "main");
    assertEquals(client.files("develop"), { "user.txt": "preserved" });
    assertEquals(
      client.requests.filter((request) =>
        request.method === "PATCH" && request.path.includes("/git/refs/")
      ).map((request) => request.path),
      ["/repos/acme/sample/git/refs/heads/develop"],
    );
  });
}

for (const files of [[], desiredFiles]) {
  Deno.test(`enforced default branch switches before bootstrap file delivery and replay (${files.length} files)`, async () => {
    const client = new BootstrapClient();
    client.defaultBranch = "main";
    const oldHead = client.root("main", { "old.txt": "preserved" });
    client.root("develop", { [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT });
    const desired: DesiredState = {
      repository: "sample",
      template: "code",
      fileDelivery: "direct",
      defaultBranchDrift: "enforce",
      settings: { defaultBranch: "develop", hasIssues: true },
      files,
    };
    const current = await readCurrentState(source(client), desired);
    const plan = buildPlan(current, desired);
    assertEquals(plan.operations[0], {
      type: "update-repository-settings",
      settings: { defaultBranch: "develop" },
    });
    assertEquals(plan.operations.at(-1), {
      type: "update-repository-settings",
      settings: { hasIssues: true },
    });
    assertEquals(fileExecutionBranch("main", plan.operations), "develop");
    const rechecked = await readCurrentState(
      source(client),
      desired,
      plan.operations,
    );
    assertEquals(rechecked.filesBranch, "develop");
    assertEquals(
      projectOwnedCurrentState(rechecked, desired, plan.operations),
      projectOwnedCurrentState(current, desired, plan.operations),
    );
    const result = await applyPlan(sink(client), plan);
    assert(result.operations.every((item) => item.status === "applied"));
    assertEquals(client.defaultBranch, "develop");
    assertEquals(client.refs.get("main"), oldHead);
    assertEquals(
      client.files("develop"),
      files.length ? { "managed.txt": "managed", "seed.txt": "seed" } : {},
    );
  });
}

Deno.test("saved cleanup plan enforces its branch through the real CLI preparation and recheck boundary", async () => {
  const client = new BootstrapClient();
  client.defaultBranch = "main";
  const oldHead = client.root("main", { "old.txt": "preserved" });
  client.root("develop", { [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT });
  const loaded: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: { include: "all" },
        settings: { defaultBranchDrift: "enforce" },
        fileChanges: { mode: "direct" },
      },
    },
    templates: {
      "repository:code": {
        version: 1,
        kind: "repository",
        match: { include: "all" },
        repository: { settings: { defaultBranch: "develop", hasIssues: true } },
      },
    },
  };
  const desired = await resolveDesiredState(loaded, {
    name: "sample",
    teams: [],
    properties: {},
  }, () => "unused");
  const current = await readCurrentState(source(client), desired);
  const plan = buildPlan(current, desired);
  const artifact = await createPersistedPlanArtifact(loaded, [{
    desired,
    current,
    plan,
    evaluations: buildApplyEvaluations(desired, plan.operations, current),
  }]);
  const runtime = createGitHubRuntime({
    token: "test",
    fetch: async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/orgs/acme/repos") {
        return Response.json([{ name: "sample", visibility: "private" }]);
      }
      try {
        const result = await client.request(
          options?.method ?? "GET",
          url.pathname,
          {
            query: Object.fromEntries(url.searchParams),
            ...(options?.body && { body: JSON.parse(String(options.body)) }),
          },
        );
        return result === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json(result);
      } catch (error) {
        if (error instanceof GitHubRequestError) {
          return new Response(error.body, { status: error.status });
        }
        throw error;
      }
    },
  });
  const reports: { status: string }[] = [];
  await applyPersistedPlan(runtime, loaded, artifact, (report) => {
    reports.push(report);
  });
  assertEquals(reports.map((report) => report.status), ["applied"]);
  assertEquals(client.defaultBranch, "develop");
  assertEquals(client.refs.get("main"), oldHead);
  assertEquals(client.files("develop"), {});
});

Deno.test("executable bootstrap cleanup ordering rejects mutations before preparation", async () => {
  const file: Operation = {
    type: "create-file",
    file: { path: "managed.txt", ensure: "exact", content: "managed" },
  };
  const cleanup: Operation = {
    type: "cleanup-repository-bootstrap",
    sha: "owned",
  };
  const settings: Operation = {
    type: "update-repository-settings",
    settings: { hasIssues: false },
  };
  const branch: Operation = {
    type: "update-repository-settings",
    settings: { defaultBranch: "develop" },
  };
  const createRuleset: Operation = {
    type: "create-ruleset",
    ruleset: {
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [],
    },
  };
  const updateRuleset: Operation = {
    type: "update-ruleset",
    id: 1,
    changes: { name: "protect", enforcement: "active" },
  };
  for (
    const operations of [
      [createRuleset, file, cleanup],
      [file, createRuleset, cleanup],
      [updateRuleset, file, cleanup],
      [file, updateRuleset, cleanup],
      [file, settings, cleanup],
      [cleanup, file],
      [file, cleanup, branch],
      [file, branch, cleanup],
      [branch, branch, file, cleanup],
    ]
  ) {
    const calls: string[] = [];
    await assertRejects(
      () =>
        applyPlan({
          prepare() {
            calls.push("prepare");
            throw new Error("must not prepare");
          },
          apply() {
            calls.push("apply");
            throw new Error("must not mutate");
          },
        }, {
          repository: "sample",
          operations,
          managedFiles: {
            branch: "main",
            baseSha: "root",
            files: [file.file],
            bootstrapCleanup: { sha: "owned" },
          },
        }),
      Error,
      "Bootstrap cleanup",
    );
    assertEquals(calls, []);
  }
});

Deno.test("lost direct cleanup response is recovered by fresh planning without duplicate commits", async () => {
  const client = new BootstrapClient();
  client.loseRefResponse = true;
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    fileDelivery: "direct",
    files: desiredFiles,
  };
  const result = await applyPlan(
    sink(client),
    buildPlan(await readCurrentState(source(client), desired), desired),
  );
  assert(result.operations.some((item) => item.status === "failed"));
  assertEquals(client.files(), {
    "managed.txt": "managed",
    "seed.txt": "seed",
  });
  assertEquals(
    buildPlan(await readCurrentState(source(client), desired), desired)
      .operations,
    [],
  );
  assertEquals(client.commits.size, 2);
});

Deno.test("unrecognized reserved content is preserved and reported", async () => {
  const client = new BootstrapClient();
  client.defaultBranch = "main";
  client.root("main", { [BOOTSTRAP_FILE_PATH]: "user content" });
  await assertRejects(
    () =>
      readCurrentState(source(client), {
        repository: "sample",
        template: "code",
      }),
    Error,
    "conflict",
  );
  assertEquals(client.files()[BOOTSTRAP_FILE_PATH], "user content");
  assertEquals(
    client.requests.filter((request) => request.method !== "GET"),
    [],
  );
});

Deno.test("cleanup rejects changed ownership and saved SHAs without writing", async () => {
  const client = new BootstrapClient();
  client.defaultBranch = "main";
  client.root("main", { [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT });
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    fileDelivery: "direct",
  };
  const plan = buildPlan(
    await readCurrentState(source(client), desired),
    desired,
  );
  client.root("main", { [BOOTSTRAP_FILE_PATH]: "user replacement" });
  const result = await applyPlan(sink(client), plan);
  assertEquals(result.operations[0].status, "failed");
  assertEquals(client.files()[BOOTSTRAP_FILE_PATH], "user replacement");
  assertEquals(
    client.requests.filter((request) => request.method !== "GET"),
    [],
  );
});

Deno.test("concurrent initialization never overwrites user content or configures protections", async () => {
  const client = new BootstrapClient();
  client.beforeContents = () =>
    client.root("main", { [BOOTSTRAP_FILE_PATH]: "user content" });
  await assertRejects(
    () =>
      new GitHubRepositoryBootstrap(client, "acme").initialize(
        "sample",
        "main",
      ),
    GitHubRequestError,
    "sha was not supplied",
  );
  assertEquals(client.files("main")[BOOTSTRAP_FILE_PATH], "user content");
  assert(!client.requests.some((request) => request.method === "PATCH"));
});

Deno.test("a concurrent non-root Contents commit fails bootstrap verification", async () => {
  const client = new BootstrapClient();
  client.beforeContents = () =>
    client.root("main", { "user.txt": "preserved" });
  await assertRejects(
    () =>
      new GitHubRepositoryBootstrap(client, "acme").initialize(
        "sample",
        "main",
      ),
    Error,
    "initialized concurrently",
  );
  assertEquals(client.files("main")["user.txt"], "preserved");
  assert(!client.requests.some((request) => request.method === "PATCH"));
});

Deno.test("existing inherited policies and unsupported branch initialization are not bypassed", async () => {
  const client = new BootstrapClient();
  client.rejectContents = true;
  await assertRejects(
    () =>
      new GitHubRepositoryBootstrap(client, "acme").initialize(
        "sample",
        "main",
      ),
    GitHubRequestError,
    "inherited policy",
  );
  assertEquals(client.commits.size, 0);
  assertEquals(
    client.requests.filter((request) => request.method !== "GET").length,
    1,
  );
  const unsupported: GitHubClient = {
    get: client.get.bind(client),
    request: () =>
      Promise.reject(
        new GitHubRequestError(
          404,
          "Not Found",
          "Requested initial branch is not supported",
        ),
      ),
  };
  client.rejectContents = false;
  await assertRejects(
    () =>
      new GitHubRepositoryBootstrap(unsupported, "acme").initialize(
        "sample",
        "develop",
      ),
    GitHubRequestError,
    "not supported",
  );
  assertEquals(client.commits.size, 0);
});

Deno.test("incorrect final default branch is not reported as successful initialization", async () => {
  const client = new BootstrapClient();
  client.ignoreDefault = true;
  await assertRejects(
    () =>
      new GitHubRepositoryBootstrap(client, "acme").initialize(
        "sample",
        "develop",
      ),
    Error,
    "intended default branch",
  );
});

for (const type of ["create-ruleset", "update-ruleset"] as const) {
  Deno.test(`direct cleanup precedes managed protection ${type}`, async () => {
    const client = new BootstrapClient();
    client.defaultBranch = "main";
    const head = client.root("main", {
      [BOOTSTRAP_FILE_PATH]: BOOTSTRAP_FILE_CONTENT,
    });
    const rule = {
      name: "protect",
      target: "push" as const,
      enforcement: "active" as const,
      bypassActors: [],
      rules: [],
    };
    const current = currentState({
      history: { initialized: true },
      bootstrapFile: {
        path: BOOTSTRAP_FILE_PATH,
        content: BOOTSTRAP_FILE_CONTENT,
        sha: "blob:" + BOOTSTRAP_FILE_CONTENT,
      },
      filesBaseSha: head,
      rulesets: type === "update-ruleset"
        ? [{ ...rule, id: 1, enforcement: "disabled" }]
        : [],
    });
    const desired: DesiredState = {
      repository: "sample",
      template: "code",
      fileDelivery: "direct",
      rulesets: [rule],
    };
    const plan = buildPlan(current, desired);
    assertEquals(plan.operations.map((operation) => operation.type), [
      "cleanup-repository-bootstrap",
      type,
    ]);
    const result = await applyPlan(sink(client), plan);
    assert(result.operations.every((item) => item.status === "applied"));
    const mutations = client.requests.filter((request) =>
      request.method !== "GET"
    );
    assert(
      mutations.findIndex((request) => request.path.includes("/git/refs/")) <
        mutations.findIndex((request) => request.path.includes("/rulesets")),
    );
    const prDesired = { ...desired, fileDelivery: "pull_request" as const };
    const prPlan = buildPlan(current, prDesired);
    assertEquals(prPlan.operations.map((operation) => operation.type), [
      "cleanup-repository-bootstrap",
    ]);
    assertEquals(
      buildApplyEvaluations(prDesired, prPlan.operations, current).find((
        evaluation,
      ) => evaluation.type === "ruleset")?.details.deferred,
      true,
    );
    assertEquals(
      buildPlan({ ...current, bootstrapFile: undefined }, prDesired).operations
        .map((operation) => operation.type),
      [type],
    );
  });
}

for (const existing of ["main", "develop"]) {
  for (const declared of [undefined, "develop"]) {
    for (const policy of ["ignore", "enforce"] as const) {
      Deno.test(`default branch matrix: ${existing}, ${declared}, ${policy}`, () => {
        const desired: DesiredState = {
          repository: "sample",
          template: "code",
          defaultBranchDrift: policy,
          settings: declared ? { defaultBranch: declared } : {},
        };
        assertEquals(
          buildPlan(
            currentState({
              settings: currentRepositorySettings({ defaultBranch: existing }),
            }),
            desired,
          ).operations,
          policy === "enforce" && declared && declared !== existing
            ? [{
              type: "update-repository-settings",
              settings: { defaultBranch: declared },
            }]
            : [],
        );
        assertEquals(
          buildPlan(
            currentState({
              history: { initialized: false },
              filesBranch: declared ?? "main",
            }),
            desired,
          ).operations,
          [{ type: "initialize-repository", branch: declared ?? "main" }, {
            type: "cleanup-repository-bootstrap",
          }],
        );
      });
    }
  }
}

for (const mode of ["direct", "pull_request"]) {
  Deno.test(`CLI plans and saves API-only empty bootstrap without mutation (${mode})`, async () => {
    const root = await Deno.makeTempDir();
    const client = new BootstrapClient();
    try {
      await Deno.mkdir(root + "/templates");
      await Deno.writeTextFile(
        root + "/octosmith.yml",
        JSON.stringify({
          version: 1,
          organization: "acme",
          repositories: { scope: { include: "all" }, file_changes: { mode } },
        }),
      );
      await Deno.writeTextFile(
        root + "/templates/code.yml",
        JSON.stringify({
          version: 1,
          kind: "repository",
          match: { include: "all" },
          repository: {},
        }),
      );
      const runtime = createGitHubRuntime({
        token: "test",
        fetch: async (input, options) => {
          const path = new URL(String(input)).pathname;
          if (path === "/orgs/acme/repos") {
            return Response.json([{ name: "sample", visibility: "private" }]);
          }
          try {
            return Response.json(
              await client.request(options?.method ?? "GET", path),
            );
          } catch (error) {
            if (error instanceof GitHubRequestError) {
              return new Response(error.body, { status: error.status });
            }
            throw error;
          }
        },
      });
      assertEquals(
        await main([
          "plan",
          "-p",
          root,
          "--format=json",
          "--out",
          root + "/plan.json",
        ], { runtime, write: () => {} }),
        0,
      );
      const saved = JSON.parse(await Deno.readTextFile(root + "/plan.json"));
      assertEquals(saved.resources[0].operations, [{
        type: "initialize-repository",
        branch: "main",
      }, { type: "cleanup-repository-bootstrap" }]);
      assertEquals(saved.resources[0].managedFiles, {
        branch: "main",
        uninitialized: true,
        files: [],
        bootstrapCleanup: { afterInitialization: true },
      });
      assertEquals(
        client.requests.filter((request) => request.method !== "GET"),
        [],
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
