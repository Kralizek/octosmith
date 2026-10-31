import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stringify } from "@std/yaml";
import {
  FetchGitHubClient,
  type GitHubClient,
} from "../../packages/octosmith/github/client.ts";

export const E2E_OWNER = "octosmith-tests";

export interface ResourceEntry {
  readonly name: string;
  readonly fullName: string;
  readonly id?: number;
}

export interface SourceFile {
  readonly target: string;
  readonly fixture?: string;
  readonly content?: string;
}

export interface Scenario {
  readonly name: string;
  readonly files?: readonly SourceFile[];
  readonly absent?: readonly string[];
  readonly commands?: readonly {
    readonly command: string;
    readonly args: readonly string[];
  }[];
  readonly fragment?: boolean;
  readonly assisted?: boolean;
  readonly expectFailure?: "before-create" | "after-create";
}

interface Repository {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly default_branch: string | null;
}

export function runPrefix(owner: string, runId: string): string {
  if (owner !== E2E_OWNER || !/^[0-9]+-[0-9]+$/.test(runId)) {
    throw new Error(
      "Refusing E2E operations outside a dedicated GitHub Actions run",
    );
  }
  return "octosmith-e2e-" + runId + "-";
}

export function safeRepository(
  prefix: string,
  repository: Repository,
): boolean {
  return repository.name.startsWith(prefix) &&
    repository.name !== "fixtures" &&
    repository.full_name === E2E_OWNER + "/" + repository.name;
}

export class E2ERuntime {
  readonly #client: GitHubClient;
  readonly #prefix: string;
  readonly #results: string;
  readonly #fixtures: string;
  readonly #registry: string;

  private constructor(
    client: GitHubClient,
    prefix: string,
    results: string,
    fixtures: string,
  ) {
    this.#client = client;
    this.#prefix = prefix;
    this.#results = results;
    this.#fixtures = fixtures;
    this.#registry = join(results, "repositories.json");
  }

  static fromEnvironment(): E2ERuntime {
    const owner = Deno.env.get("E2E_OWNER") ?? "";
    const runId = Deno.env.get("E2E_RUN_ID") ?? "";
    const results = Deno.env.get("E2E_RESULTS") ?? "";
    const fixtures = Deno.env.get("E2E_FIXTURES") ?? "";
    const token = Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GH_TOKEN");
    const prefix = runPrefix(owner, runId);
    if (!results || !fixtures || !token) {
      throw new Error("Missing E2E_RESULTS, E2E_FIXTURES, or GitHub App token");
    }
    return new E2ERuntime(
      new FetchGitHubClient({ token }),
      prefix,
      results,
      fixtures,
    );
  }

  async verifyInstallation(): Promise<void> {
    const owner = await this.#client.get<{ type: string }>(
      "/users/" + E2E_OWNER,
    );
    assertEquals(owner.type, "Organization");
    const installation = await this.#client.get<{
      repositories: { full_name: string }[];
    }>("/installation/repositories");
    assert(
      installation.repositories.some((r) =>
        r.full_name === E2E_OWNER + "/fixtures"
      ),
      "GitHub App installation must include fixtures",
    );
  }

  async #repository(name: string): Promise<Repository | undefined> {
    return await this.#client.request<Repository | undefined>(
      "GET",
      "/repos/" + E2E_OWNER + "/" + name,
      { allowNotFound: true },
    );
  }

  async #readRegistry(): Promise<ResourceEntry[]> {
    try {
      return JSON.parse(
        await Deno.readTextFile(this.#registry),
      ) as ResourceEntry[];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
  }

  async #saveRegistry(entries: ResourceEntry[]): Promise<void> {
    await Deno.mkdir(this.#results, { recursive: true });
    await Deno.writeTextFile(
      this.#registry,
      JSON.stringify(entries, null, 2) + "\n",
    );
  }

  async #register(name: string): Promise<void> {
    if (!name.startsWith(this.#prefix) || name === "fixtures") {
      throw new Error("Unsafe E2E repository name");
    }
    if (await this.#repository(name)) {
      throw new Error("Refusing to adopt an existing repository: " + name);
    }
    const entries = await this.#readRegistry();
    if (entries.some((entry) => entry.name === name)) {
      throw new Error("Repository already registered: " + name);
    }
    entries.push({ name, fullName: E2E_OWNER + "/" + name });
    await this.#saveRegistry(entries);
  }

  async #recordId(name: string, id: number): Promise<void> {
    const entries = await this.#readRegistry();
    await this.#saveRegistry(
      entries.map((entry) => entry.name === name ? { ...entry, id } : entry),
    );
  }

  async #execute(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "packages/cli/mod.ts", ...args],
      stdout: "piped",
      stderr: "piped",
      env: { GIT_TERMINAL_PROMPT: "0" },
    }).output();
    return {
      code: child.code,
      stdout: new TextDecoder().decode(child.stdout),
      stderr: new TextDecoder().decode(child.stderr),
    };
  }

  // util-linux script allocates the real PTY required by --assisted.
  // Arguments are fixed by the test; the repository name is run-prefixed.
  async #executeTerminal(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const quoted = [Deno.execPath(), "run", "-A", "packages/cli/mod.ts", ...args]
      .map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'")
      .join(" ");
    const child = await new Deno.Command("script", {
      args: ["-q", "-e", "-c", quoted, "/dev/null"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: { GIT_TERMINAL_PROMPT: "0" },
    }).output();
    return {
      code: child.code,
      stdout: new TextDecoder().decode(child.stdout),
      stderr: new TextDecoder().decode(child.stderr),
    };
  }

  async #prepare(scenario: Scenario, name: string): Promise<string> {
    const root = join(this.#results, "workspaces", scenario.name);
    await Deno.mkdir(join(root, "templates"), { recursive: true });
    await Deno.mkdir(join(root, "files"), { recursive: true });
    const files: Record<string, unknown> = {};
    for (const source of scenario.files ?? []) {
      const path = "files/" + source.target;
      const target = join(root, path);
      await Deno.mkdir(
        join(root, "files", ...source.target.split("/").slice(0, -1)),
        {
          recursive: true,
        },
      );
      if (source.fixture) {
        await Deno.copyFile(join(this.#fixtures, source.fixture), target);
      } else {
        await Deno.writeTextFile(target, source.content ?? "");
      }
      files[source.target] = { ensure: "exact", source: path };
    }
    for (const path of scenario.absent ?? []) {
      files[path] = { ensure: "absent" };
    }

    const repository: Record<string, unknown> = {
      settings: {
        visibility: "private",
        default_branch: "main",
        has_issues: false,
      },
      ...(scenario.commands && { post_create_commands: scenario.commands }),
      ...(Object.keys(files).length > 0 && { files }),
    };
    const template: Record<string, unknown> = {
      version: 1,
      kind: "repository",
      match: { include: { names: [name] } },
      repository,
    };
    if (scenario.fragment) {
      await Deno.mkdir(join(root, "fragments"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "fragments", "base.yml"),
        stringify({
          version: 1,
          kind: "fragment",
          resource: "repository",
          repository: { settings: { has_wiki: false } },
        }),
      );
      template.includes = ["../fragments/base.yml"];
    }
    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      stringify({
        version: 1,
        organization: E2E_OWNER,
        repositories: {
          scope: { include: { names: [name], visibility: "private" } },
          file_changes: { mode: "direct" },
        },
      }),
    );
    await Deno.writeTextFile(
      join(root, "templates", "scenario.yml"),
      stringify(template),
    );
    return root;
  }

  async #inspect(
    name: string,
    expected: ReadonlyMap<string, Uint8Array>,
  ): Promise<void> {
    const repo = await this.#repository(name);
    assert(repo, "Repository not found after successful creation");
    assert(
      safeRepository(this.#prefix, repo),
      "Unexpected repository identity",
    );
    assertEquals(repo.private, true);
    await this.#recordId(name, repo.id);
    assert(repo.default_branch, "Repository has no default branch");
    const branch = await this.#client.get<{ commit: { sha: string } }>(
      "/repos/" + E2E_OWNER + "/" + name + "/branches/" + repo.default_branch,
    );
    const commit = await this.#client.get<{
      parents: unknown[];
      tree: { sha: string };
    }>(
      "/repos/" + E2E_OWNER + "/" + name + "/git/commits/" + branch.commit.sha,
    );
    assertEquals(
      commit.parents.length,
      0,
      "Bootstrap must have exactly one root commit",
    );
    const tree = await this.#client.get<{
      tree: { path: string; type: string }[];
    }>("/repos/" + E2E_OWNER + "/" + name + "/git/trees/" + commit.tree.sha, {
      recursive: 1,
    });
    const paths = tree.tree.filter((entry) => entry.type === "blob").map((
      entry,
    ) => entry.path).sort();
    assertEquals(
      paths,
      [...expected.keys()].sort(),
      "Unexpected remote Git tree",
    );

    for (const [path, bytes] of expected) {
      const uri = path.split("/").map(encodeURIComponent).join("/");
      const remote = await this.#client.get<
        { content: string; encoding: string }
      >(
        "/repos/" + E2E_OWNER + "/" + name + "/contents/" + uri,
      );
      assertEquals(remote.encoding, "base64");
      const decoded = Uint8Array.from(
        atob(remote.content.replace(/\s/g, "")),
        (c) => c.charCodeAt(0),
      );
      assertEquals(decoded, bytes, "Unexpected remote bytes for " + path);
    }
  }

  async runCreation(scenario: Scenario): Promise<void> {
    const name = this.#prefix + scenario.name;
    await this.#register(name);
    try {
      const path = await this.#prepare(scenario, name);
      const creationArgs = [
        "resource",
        "create",
        "scenario",
        "--path",
        path,
        "--name",
        name,
        "--visibility",
        "private",
        ...(scenario.assisted ? ["--assisted"] : ["--format", "json"]),
      ];
      const creation = scenario.assisted
        ? await this.#executeTerminal(creationArgs)
        : await this.#execute(creationArgs);
      await Deno.writeTextFile(
        join(this.#results, scenario.name + "-creation.json"),
        creation.stdout ||
          JSON.stringify({ exit: creation.code, stderr: creation.stderr }),
      );
      if (scenario.expectFailure) {
        assert(creation.code !== 0, "Expected creation to fail");
        const remote = await this.#repository(name);
        if (scenario.expectFailure === "before-create") {
          assertEquals(
            remote,
            undefined,
            "Preflight failure created a repository",
          );
        } else {
          assert(remote, "Expected partial repository after bootstrap failure");
          assert(safeRepository(this.#prefix, remote));
          await this.#recordId(name, remote.id);
        }
        return;
      }
      assertEquals(
        creation.code,
        0,
        "Octosmith creation failed: " + creation.stderr,
      );
      if (scenario.assisted) {
        assert(
          creation.stdout.includes("Repository creation: completed"),
          "Assisted CLI did not report successful completion",
        );
      } else {
        const outcome = JSON.parse(creation.stdout);
        assertEquals(outcome.status, "completed");
      }

      const expected = new Map<string, Uint8Array>();
      for (const source of scenario.files ?? []) {
        expected.set(
          source.target,
          source.fixture
            ? await Deno.readFile(join(this.#fixtures, source.fixture))
            : new TextEncoder().encode(source.content ?? ""),
        );
      }
      if (scenario.commands) {
        expected.set(
          "generator-output.txt",
          new TextEncoder().encode("generated\n"),
        );
      }
      await this.#inspect(name, expected);
      const plan = await this.#execute([
        "plan",
        "--path",
        path,
        "--format",
        "json",
      ]);
      await Deno.writeTextFile(
        join(this.#results, scenario.name + "-plan.json"),
        plan.stdout,
      );
      assertEquals(plan.code, 0, "Post-creation plan failed: " + plan.stderr);
      const report = JSON.parse(plan.stdout) as {
        repositories: {
          repository: string;
          status: string;
          items: { status: string }[];
        }[];
      };
      assertEquals(
        report.repositories.length,
        1,
        "Wrong number of selected repositories",
      );
      assertEquals(report.repositories[0].repository, name);
      assertEquals(
        report.repositories[0].items.filter((item) =>
          item.status === "planned"
        ),
        [],
        "Repository still has outstanding operations",
      );
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    const entries = await this.#readRegistry();
    const ids = new Map(entries.map((entry) => [entry.name, entry.id]));
    const names = new Set(entries.map((entry) => entry.name));
    for (let page = 1;; page++) {
      const repositories = await this.#client.get<Repository[]>(
        "/orgs/" + E2E_OWNER + "/repos",
        { per_page: 100, page, type: "all" },
      );
      for (const repo of repositories) {
        if (safeRepository(this.#prefix, repo)) names.add(repo.name);
      }
      if (repositories.length < 100) break;
    }
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const name of [...names].sort()) {
      if (!name.startsWith(this.#prefix) || name === "fixtures") {
        failed.push("Refused unsafe name: " + name);
        continue;
      }
      try {
        const repo = await this.#repository(name);
        if (!repo) continue;
        if (
          !safeRepository(this.#prefix, repo) ||
          (ids.get(name) !== undefined && ids.get(name) !== repo.id)
        ) {
          throw new Error("Owner/name/ID mismatch");
        }
        await this.#client.request<void>("DELETE", "/repos/" + repo.full_name);
        deleted.push(repo.full_name);
      } catch (error) {
        failed.push(name + ": " + String(error));
      }
    }
    await Deno.mkdir(this.#results, { recursive: true });
    await Deno.writeTextFile(
      join(this.#results, "cleanup.json"),
      JSON.stringify({ deleted, failed }, null, 2) + "\n",
    );
    if (failed.length) {
      throw new Error("E2E cleanup incomplete: " + failed.join("; "));
    }
  }
}
