import type { GitHubClient } from "./client.ts";

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha?: string | null;
  readonly content?: string;
}

/** Create a managed-file tree, including GitHub's cleanup-only empty-tree case. */
export async function createManagedFileTree(
  client: GitHubClient,
  repositoryPath: string,
  baseTree: string,
  entries: readonly TreeEntry[],
  bootstrapCleanup: boolean,
): Promise<{ readonly sha: string }> {
  if (
    bootstrapCleanup && entries.length > 0 &&
    entries.every((entry) => entry.sha === null)
  ) {
    const current = await client.get<
      {
        readonly truncated: boolean;
        readonly tree: readonly {
          readonly path: string;
          readonly type: string;
        }[];
      }
    >(repositoryPath + "/git/trees/" + baseTree, { recursive: true });
    if (current.truncated) {
      throw new Error(
        "Cannot verify bootstrap cleanup against a truncated Git tree",
      );
    }
    const removed = new Set(entries.map((entry) => entry.path));
    if (
      current.tree.every((entry) =>
        entry.type === "tree" || removed.has(entry.path)
      )
    ) {
      const digest = await crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode("tree 0\0"),
      );
      return {
        sha: [...new Uint8Array(digest)].map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join(""),
      };
    }
  }
  return await client.request("POST", repositoryPath + "/git/trees", {
    body: { base_tree: baseTree, tree: entries },
  });
}
