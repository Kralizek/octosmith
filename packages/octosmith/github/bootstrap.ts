import {
  assertBootstrapFileOwned,
  BOOTSTRAP_FILE_CONTENT,
  BOOTSTRAP_FILE_PATH,
} from "../state/bootstrap.ts";
import type { GitHubClient } from "./client.ts";
import { GitHubRepositoryStateSource } from "./rest_state_source.ts";

/** Reusable API-only initialization boundary for an existing empty repository. */
export interface RepositoryBootstrap {
  prepare?(branch: string): void;
  initialize(
    repository: string,
    branch: string,
    expectedHead?: string,
  ): Promise<void>;
}

/** Initialize through the Contents API, then verify and select the initial default branch. */
export class GitHubRepositoryBootstrap implements RepositoryBootstrap {
  constructor(readonly client: GitHubClient, readonly owner: string) {}

  prepare(branch: string): void {
    if (!validInitialBranch(branch)) {
      throw new Error("Invalid bootstrap branch: " + branch);
    }
  }

  async initialize(
    repository: string,
    branch: string,
    expectedHead?: string,
  ): Promise<void> {
    this.prepare(branch);
    const path = "/repos/" + encodeURIComponent(this.owner) + "/" +
      encodeURIComponent(repository);
    const source = new GitHubRepositoryStateSource(this.client, this.owner);
    const settings = await source.getRepositorySettings(repository);
    const history = await source.getRepositoryHistory(
      repository,
      settings.defaultBranch,
    );
    let head: string;
    if (expectedHead === undefined) {
      if (history.initialized) {
        throw new Error(
          "Repository acquired Git history before bootstrap; build a fresh plan",
        );
      }
      const result = await this.client.request<{
        readonly commit: {
          readonly sha: string;
          readonly parents: readonly unknown[];
        };
      }>("PUT", path + "/contents/" + BOOTSTRAP_FILE_PATH, {
        body: {
          message: "Octosmith: initialize repository",
          content: btoa(BOOTSTRAP_FILE_CONTENT),
          branch,
        },
      });
      if (result.commit.parents.length !== 0) {
        throw new Error(
          "Repository was initialized concurrently; inspect its history and build a fresh plan",
        );
      }
      head = result.commit.sha;
    } else {
      if (
        !history.initialized || history.branch !== branch ||
        history.head !== expectedHead
      ) {
        throw new Error(
          "Bootstrap recovery precondition changed; build a fresh plan",
        );
      }
      head = expectedHead;
    }

    const assertRoot = async () => {
      const branches = await this.client.get<
        readonly {
          readonly name: string;
          readonly commit: { readonly sha: string };
        }[]
      >(path + "/branches", { per_page: 100 });
      if (
        branches.length !== 1 || branches[0].name !== branch ||
        branches[0].commit.sha !== head
      ) {
        throw new Error(
          "Bootstrap branch state changed concurrently; inspect branches and build a fresh plan",
        );
      }
      const commit = await this.client.get<
        {
          readonly parents: readonly unknown[];
          readonly tree: { readonly sha: string };
        }
      >(path + "/git/commits/" + head);
      if (commit.parents.length !== 0) {
        throw new Error("Bootstrap recovery requires the original root commit");
      }
      const tree = await this.client.get<
        {
          readonly truncated: boolean;
          readonly tree: readonly {
            readonly path: string;
            readonly type: string;
          }[];
        }
      >(path + "/git/trees/" + commit.tree.sha, { recursive: true });
      const blobs = tree.tree.filter((entry) => entry.type !== "tree");
      if (
        tree.truncated || blobs.length !== 1 ||
        blobs[0].path !== BOOTSTRAP_FILE_PATH || blobs[0].type !== "blob"
      ) {
        throw new Error(
          "Bootstrap recovery requires a root tree containing only the reserved bootstrap file",
        );
      }
      const file = await source.getFile(repository, BOOTSTRAP_FILE_PATH, head);
      if (!file) {
        throw new Error("Bootstrap file is missing after initialization");
      }
      assertBootstrapFileOwned(file);
      if (await source.getBranchHead(repository, branch) !== head) {
        throw new Error(
          "Bootstrap head changed concurrently; build a fresh plan",
        );
      }
    };
    await assertRoot();
    const beforeDefault = await source.getRepositorySettings(repository);
    if (beforeDefault.defaultBranch !== branch) {
      if (beforeDefault.defaultBranch !== settings.defaultBranch) {
        throw new Error(
          "Repository default branch changed during bootstrap; build a fresh plan",
        );
      }
      await this.client.request("PATCH", path, {
        body: { default_branch: branch },
      });
    }
    await assertRoot();
    const after = await source.getRepositorySettings(repository);
    if (after.defaultBranch !== branch) {
      throw new Error(
        "GitHub did not establish the intended default branch " + branch +
          "; inspect repository policies and retry with a fresh plan",
      );
    }
  }
}

function validInitialBranch(branch: string): boolean {
  return branch.length > 0 && branch !== "@" && !branch.startsWith("-") &&
    !branch.includes("..") && !branch.includes("@{") &&
    !/[~^:?*\[\\]/.test(branch) &&
    [...branch].every((character) =>
      character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127
    ) &&
    branch.split("/").every((part) =>
      part.length > 0 && !part.startsWith(".") && !part.endsWith(".") &&
      !part.endsWith(".lock")
    );
}
