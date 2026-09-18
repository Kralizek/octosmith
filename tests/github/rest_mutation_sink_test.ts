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
