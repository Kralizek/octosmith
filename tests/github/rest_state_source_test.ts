import { assertEquals } from "@std/assert";
import {
  GitHubRepositoryStateSource,
  type GitHubClient,
  type GitHubQueryValue,
} from "@octosmith/github";

class PagingClient implements GitHubClient {
  readonly requests: string[] = [];

  request<T>(
    method: string,
    path: string,
    options: import("@octosmith/github").GitHubRequestOptions = {},
  ): Promise<T> {
    if (method !== "GET") {
      throw new Error("Unexpected method: " + method);
    }

    return this.get(path, options.query);
  }

  get<T>(
    path: string,
    query: Readonly<Record<string, GitHubQueryValue>> = {},
  ): Promise<T> {
    const page = Number(query.page ?? 1);
    this.requests.push(path + "?page=" + page);

    if (path === "/repos/acme/sample/teams") {
      const count = page === 1 ? 100 : 1;
      return Promise.resolve(
        Array.from({ length: count }, (_, index) => ({
          slug: "team-" + ((page - 1) * 100 + index),
          permission: "pull",
        })) as T,
      );
    }

    if (path === "/repos/acme/sample/actions/variables") {
      const count = page === 1 ? 100 : 1;
      return Promise.resolve({
        variables: Array.from({ length: count }, (_, index) => ({
          name: "VAR_" + ((page - 1) * 100 + index),
          value: String((page - 1) * 100 + index),
        })),
      } as T);
    }

    throw new Error("Unexpected request: " + path);
  }
}

Deno.test("state source paginates array and wrapped collections", async () => {
  const client = new PagingClient();
  const source = new GitHubRepositoryStateSource(client, "acme");

  const [teams, variables] = await Promise.all([
    source.getTeams("sample"),
    source.getVariables("sample"),
  ]);

  assertEquals(teams.length, 101);
  assertEquals(teams[100].team, "team-100");
  assertEquals(variables.length, 101);
  assertEquals(variables[100], { name: "VAR_100", value: "100" });
  assertEquals(client.requests.sort(), [
    "/repos/acme/sample/actions/variables?page=1",
    "/repos/acme/sample/actions/variables?page=2",
    "/repos/acme/sample/teams?page=1",
    "/repos/acme/sample/teams?page=2",
  ]);
});
