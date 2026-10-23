import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  applyPlan,
  buildPlan,
  type DesiredFile,
  type DesiredState,
  type GitHubClient,
  GitHubRepositoryBootstrap,
  GitHubRepositoryMutationSink,
  GitHubRepositoryStateSource,
  GitHubRequestError,
  initializeGitRepository,
  projectOwnedCurrentState,
  readCurrentState,
} from "@octosmith/octosmith";
import { currentRepositorySettings, currentState } from "../plan/fixtures.ts";
import { createGitHubRuntime, main } from "../../packages/cli/mod.ts";

Deno.test("GitHub bootstrap rejects concurrent initialization before invoking Git", async () => {
  const client = new BootstrapClient();
  client.initialized = true;
  await assertRejects(
    () =>
      new GitHubRepositoryBootstrap(client, "acme", "test").initialize(
        "sample",
        "main",
        [],
      ),
    Error,
    "acquired Git history",
  );
  assertEquals(client.mutations, []);
});

for (const mode of ["direct", "pull_request"]) {
  Deno.test(`CLI plans and saves empty repositories without mutation (${mode})`, async () => {
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
      const output: string[] = [];
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
        ], { runtime, write: (value) => output.push(value) }),
        0,
      );
      const saved = JSON.parse(await Deno.readTextFile(root + "/plan.json"));
      assertEquals(saved.resources[0].operations, [{
        type: "initialize-repository",
        branch: "main",
      }]);
      assertEquals(saved.resources[0].managedFiles, {
        branch: "main",
        uninitialized: true,
        files: [],
      });
      const report = JSON.parse(output.join("\n"));
      assertEquals(
        report.repositories[0].items[0].type,
        "repository-initialization",
      );
      assertEquals(client.mutations, []);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

const managed: readonly DesiredFile[] = [
  { path: "nested/file.txt", ensure: "exact", content: "managed\n" },
  { path: "seed.txt", ensure: "exists", content: "seed\n" },
  { path: "absent.txt", ensure: "absent" },
];

async function git(args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

for (const branch of ["main", "develop"]) {
  for (const files of [[], managed]) {
    Deno.test(`real Git bootstrap creates one root commit on ${branch} with ${files.length} file declarations`, async () => {
      const root = await Deno.makeTempDir();
      const remoteUrl = root + "/remote.git";
      try {
        await git(["init", "--bare", "--initial-branch=" + branch, remoteUrl]);
        await initializeGitRepository({ remoteUrl, branch, files });
        assertEquals(
          await git(["--git-dir=" + remoteUrl, "rev-list", "--count", branch]),
          "1",
        );
        const commit = await git([
          "--git-dir=" + remoteUrl,
          "cat-file",
          "-p",
          branch,
        ]);
        assert(!commit.includes("\nparent "));
        assertStringIncludes(
          commit,
          "Octosmith <octosmith@users.noreply.github.com>",
        );
        assertEquals(
          await git([
            "--git-dir=" + remoteUrl,
            "ls-tree",
            "-r",
            "--name-only",
            branch,
          ]),
          files.length ? "nested/file.txt\nseed.txt" : "",
        );
        if (files.length) {
          assertEquals(
            await git([
              "--git-dir=" + remoteUrl,
              "show",
              branch + ":nested/file.txt",
            ]),
            "managed",
          );
        }
        await assertRejects(
          () => initializeGitRepository({ remoteUrl, branch, files }),
          Error,
          "acquired Git history",
        );
        assertEquals(
          await git(["--git-dir=" + remoteUrl, "rev-list", "--count", branch]),
          "1",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

Deno.test("real Git bootstrap respects server protections without bypassing hooks", async () => {
  const root = await Deno.makeTempDir();
  const remoteUrl = root + "/remote.git";
  try {
    await git(["init", "--bare", "--initial-branch=main", remoteUrl]);
    await Deno.writeTextFile(
      remoteUrl + "/hooks/pre-receive",
      "#!/bin/sh\necho 'GH013: inherited policy requires signed commits' >&2\nexit 1\n",
    );
    await Deno.chmod(remoteUrl + "/hooks/pre-receive", 0o755);
    await assertRejects(
      () => initializeGitRepository({ remoteUrl, branch: "main", files: [] }),
      Error,
      "inherited policy requires signed commits",
    );
    assertEquals(await git(["ls-remote", "--refs", remoteUrl]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

class BootstrapClient implements GitHubClient {
  initialized = false;
  branch = "main";
  files: readonly DesiredFile[] = [];
  readonly mutations: string[] = [];
  failRules = false;

  get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }
  request<T>(method: string, path: string): Promise<T> {
    if (method !== "GET") {
      this.mutations.push(path);
      if (this.failRules) throw new Error("policy rejected");
      return Promise.resolve({} as T);
    }
    if (path === "/repos/acme/sample") {
      return Promise.resolve(
        {
          name: "sample",
          default_branch: this.branch,
          visibility: "private",
        } as T,
      );
    }
    if (path.includes("/git/ref/heads/")) {
      if (!this.initialized) {
        throw new GitHubRequestError(
          409,
          "Conflict",
          JSON.stringify({ message: "Git Repository is empty." }),
        );
      }
      if (!path.endsWith("/" + this.branch)) {
        throw new GitHubRequestError(404, "Not Found", "");
      }
      return Promise.resolve({ object: { sha: "real-head" } } as T);
    }
    if (path.includes("/contents/")) {
      const file = this.files.find((file) =>
        file.path === path.split("/contents/")[1]
      );
      return Promise.resolve(
        file && file.ensure !== "absent"
          ? {
            type: "file",
            encoding: "base64",
            sha: "blob",
            content: btoa(file.content),
          } as T
          : undefined as T,
      );
    }
    throw new Error("Unexpected request: " + path);
  }
}

for (const existing of ["main", "develop"]) {
  for (const declared of [undefined, "develop"]) {
    for (const policy of ["ignore", "enforce"] as const) {
      Deno.test(`branch matrix: ${existing}, declared ${declared}, ${policy}`, () => {
        const desired: DesiredState = {
          repository: "sample",
          template: "code",
          defaultBranchDrift: policy,
          settings: declared ? { defaultBranch: declared } : {},
        };
        const initialized = buildPlan(
          currentState({
            settings: currentRepositorySettings({ defaultBranch: existing }),
          }),
          desired,
        );
        assertEquals(
          initialized.operations,
          policy === "enforce" && declared && declared !== existing
            ? [{
              type: "update-repository-settings",
              settings: { defaultBranch: declared },
            }]
            : [],
        );
        const empty = buildPlan(
          currentState({
            history: { initialized: false },
            filesBranch: declared ?? "main",
          }),
          desired,
        );
        assertEquals(empty.operations, [{
          type: "initialize-repository",
          branch: declared ?? "main",
        }]);
      });
    }
  }
}

Deno.test("empty state works without files and branch enforcement never creates a missing target", async () => {
  const client = new BootstrapClient();
  const source = new GitHubRepositoryStateSource(client, "acme");
  const desired: DesiredState = { repository: "sample", template: "code" };
  const empty = await readCurrentState(source, desired, undefined, {
    authoritativeFiles: true,
  });
  assertEquals(empty.history, { initialized: false });
  assertEquals(empty.filesBaseSha, undefined);
  assertEquals(buildPlan(empty, desired).operations, [{
    type: "initialize-repository",
    branch: "main",
  }]);
  client.initialized = true;
  await assertRejects(
    () =>
      readCurrentState(source, {
        ...desired,
        defaultBranchDrift: "enforce",
        settings: { defaultBranch: "develop" },
      }),
    Error,
    "Ensure the branch exists",
  );
  const ignored = await readCurrentState(source, {
    ...desired,
    settings: { defaultBranch: "develop" },
    files: managed,
  });
  assertEquals(ignored.filesBranch, "main");
  assertEquals(client.mutations, []);
});

for (const files of [[], managed]) {
  Deno.test(`direct bootstrap consumes files and retry does not bootstrap again (${files.length})`, async () => {
    const client = new BootstrapClient();
    const desired: DesiredState = {
      repository: "sample",
      template: "code",
      files,
    };
    const source = new GitHubRepositoryStateSource(client, "acme");
    const current = await readCurrentState(source, desired);
    const plan = buildPlan(current, desired);
    let initializations = 0;
    const sink = new GitHubRepositoryMutationSink({
      client,
      owner: "acme",
      secretValue: () => "unused",
      fileChanges: { mode: "direct" },
      bootstrap: {
        initialize(_repository, branch, initialFiles) {
          initializations++;
          client.initialized = true;
          client.branch = branch;
          client.files = initialFiles;
          return Promise.resolve();
        },
      },
    });
    const result = await applyPlan(sink, plan);
    assert(result.operations.every((item) => item.status === "applied"));
    assertEquals(initializations, 1);
    assertEquals(
      client.files,
      files.filter((file) => file.ensure !== "absent"),
    );
    assertEquals(client.mutations, []);
    const after = await readCurrentState(source, desired);
    assertEquals(buildPlan(after, desired).operations, []);
    assert(
      JSON.stringify(
        projectOwnedCurrentState(current, desired, plan.operations),
      ) !==
        JSON.stringify(
          projectOwnedCurrentState(after, desired, plan.operations),
        ),
    );
  });
}

Deno.test("bootstrap precedes both protection creates and updates and survives later failure", async () => {
  for (const type of ["create-ruleset", "update-ruleset"] as const) {
    const client = new BootstrapClient();
    client.failRules = true;
    const ruleset = {
      name: "protect",
      target: "push" as const,
      enforcement: "active" as const,
      bypassActors: [],
      rules: [],
    };
    const desired = {
      repository: "sample",
      template: "code",
      rulesets: [ruleset],
    };
    const before = currentState({
      history: { initialized: false },
      rulesets: type === "update-ruleset"
        ? [{ ...ruleset, id: 1, enforcement: "disabled" }]
        : [],
    });
    const plan = buildPlan(before, desired);
    assertEquals(plan.operations.map((item) => item.type), [
      "initialize-repository",
      type,
    ]);
    const result = await applyPlan(
      new GitHubRepositoryMutationSink({
        client,
        owner: "acme",
        secretValue: () => "unused",
        bootstrap: {
          initialize() {
            assertEquals(client.mutations, []);
            client.initialized = true;
            return Promise.resolve();
          },
        },
      }),
      plan,
    );
    assertEquals(result.operations.map((item) => item.status), [
      "applied",
      "failed",
    ]);
    assertEquals(
      buildPlan({ ...before, history: { initialized: true } }, desired)
        .operations.map((item) => item.type),
      [type],
    );
  }
});

Deno.test("failed bootstrap blocks protection even with continueOnError", async () => {
  const calls: string[] = [];
  const result = await applyPlan({
    apply(_repository, operation) {
      calls.push(operation.type);
      throw new Error("concurrently initialized or protected");
    },
  }, {
    repository: "sample",
    operations: [{ type: "initialize-repository", branch: "main" }, {
      type: "update-repository-settings",
      settings: { hasIssues: true },
    }],
  }, { continueOnError: true });
  assertEquals(calls, ["initialize-repository"]);
  assertEquals(result.operations.map((item) => item.status), [
    "failed",
    "skipped",
  ]);
});
