import type { DesiredFile } from "../state/types.ts";
import type { GitHubClient } from "./client.ts";
import { GitHubRepositoryStateSource } from "./rest_state_source.ts";

/** Reusable initialization boundary for existing repositories without Git history. */
export interface RepositoryBootstrap {
  prepare?(branch: string): void;
  initialize(
    repository: string,
    branch: string,
    files: readonly DesiredFile[],
  ): Promise<void>;
}

/** Inputs for a single isolated initial Git push. */
export interface GitBootstrapOptions {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly files: readonly DesiredFile[];
  readonly token?: string;
  readonly message?: string;
}

/** Create one root commit and push it without overwriting an existing branch. */
export async function initializeGitRepository(
  options: GitBootstrapOptions,
): Promise<void> {
  const environment: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Octosmith",
    GIT_AUTHOR_EMAIL: "octosmith@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Octosmith",
    GIT_COMMITTER_EMAIL: "octosmith@users.noreply.github.com",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  if (options.token !== undefined) {
    const remote = new URL(options.remoteUrl);
    if (remote.protocol !== "https:" || remote.username || remote.password) {
      throw new Error(
        "Authenticated bootstrap requires an HTTPS clone URL without credentials",
      );
    }
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "http." + remote.origin + "/.extraHeader";
    environment.GIT_CONFIG_VALUE_0 = "Authorization: Basic " +
      btoa("x-access-token:" + options.token);
  }
  const directory = await Deno.makeTempDir({ prefix: "octosmith-bootstrap-" });
  const git = async (
    args: readonly string[],
    input?: string,
  ): Promise<string> => {
    const command = new Deno.Command("git", {
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "http.followRedirects=false",
        ...args,
      ],
      cwd: directory,
      clearEnv: true,
      env: environment,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (input !== undefined) {
      const writer = command.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const result = await command.output();
    if (!result.success) {
      let diagnostic = new TextDecoder().decode(result.stderr).trim();
      if (options.token) {
        diagnostic = diagnostic.replaceAll(options.token, "[REDACTED]")
          .replaceAll(btoa("x-access-token:" + options.token), "[REDACTED]");
      }
      throw new Error(
        "Repository bootstrap failed: " + diagnostic +
          ". Check repository permissions and existing or inherited protection policies; Octosmith will not bypass them.",
      );
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    await git(["check-ref-format", "--branch", options.branch]);
    await git(["init", "--initial-branch=" + options.branch, "."]);
    if (await git(["ls-remote", "--refs", "--", options.remoteUrl])) {
      throw new Error(
        "Repository acquired Git history before bootstrap; build a fresh plan",
      );
    }
    for (const file of options.files) {
      if (file.ensure === "absent") continue;
      if (
        file.path.startsWith("/") || file.path.includes("\\") ||
        file.path.includes("\0") ||
        file.path.split("/").some((part) =>
          !part || part === "." || part === ".." ||
          part.toLowerCase() === ".git"
        )
      ) {
        throw new Error("Invalid bootstrap file path: " + file.path);
      }
      const sha = await git(["hash-object", "-w", "--stdin"], file.content);
      await git([
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        sha,
        file.path,
      ]);
    }
    const tree = await git(["write-tree"]);
    const commit = await git(
      ["commit-tree", tree],
      (options.message ?? "Octosmith: initialize repository") + "\n",
    );
    const pushed = await git([
      "push",
      "--porcelain",
      "--force-with-lease=refs/heads/" + options.branch + ":",
      "--",
      options.remoteUrl,
      commit + ":refs/heads/" + options.branch,
    ]);
    if (!pushed.split("\n").some((line) => line.startsWith("*\t"))) {
      throw new Error(
        "Repository was initialized concurrently; build a fresh plan",
      );
    }
    const refs = await git(["ls-remote", "--refs", "--", options.remoteUrl]);
    if (refs !== commit + "\trefs/heads/" + options.branch) {
      throw new Error(
        "Repository changed concurrently during bootstrap; inspect its branches and build a fresh plan",
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

/** Initialize through Git transport and verify GitHub's authoritative repository state. */
export class GitHubRepositoryBootstrap implements RepositoryBootstrap {
  constructor(
    readonly client: GitHubClient,
    readonly owner: string,
    private readonly token: string,
  ) {}

  prepare(branch: string): void {
    const result = new Deno.Command("git", {
      args: ["check-ref-format", "--branch", branch],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!result.success) throw new Error("Invalid bootstrap branch: " + branch);
  }

  async initialize(
    repository: string,
    branch: string,
    files: readonly DesiredFile[],
  ): Promise<void> {
    const path = "/repos/" + encodeURIComponent(this.owner) + "/" +
      encodeURIComponent(repository);
    const source = new GitHubRepositoryStateSource(this.client, this.owner);
    const metadata = await this.client.get<
      { readonly clone_url: string; readonly default_branch: string }
    >(path);
    if (
      (await source.getRepositoryHistory(repository, metadata.default_branch))
        .initialized
    ) {
      throw new Error(
        "Repository acquired Git history before bootstrap; build a fresh plan",
      );
    }
    await initializeGitRepository({
      remoteUrl: metadata.clone_url,
      branch,
      files,
      token: this.token,
    });
    await source.getBranchHead(repository, branch);
    const after = await source.getRepositorySettings(repository);
    if (after.defaultBranch !== branch) {
      throw new Error(
        "Bootstrap created " + branch + " but GitHub reports default branch " +
          after.defaultBranch +
          "; inspect concurrent initialization or organization policies before retrying",
      );
    }
  }
}
