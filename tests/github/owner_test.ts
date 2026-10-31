import { assertEquals, assertRejects } from "@std/assert";
import {
  FetchGitHubClient,
  RepositoryOwnerResolutionError,
  resolveRepositoryOwner,
} from "@octosmith/octosmith";

Deno.test("owner resolution returns GitHub's canonical organization identity", async () => {
  const requests: string[] = [];
  const client = new FetchGitHubClient({
    token: "test",
    fetch: (input) => {
      requests.push(new URL(String(input)).pathname);
      return Promise.resolve(
        Response.json({ login: "CanonicalOrg", type: "Organization" }),
      );
    },
  });

  assertEquals(await resolveRepositoryOwner(client, "canonicalorg"), {
    login: "CanonicalOrg",
    type: "Organization",
  });
  assertEquals(requests, ["/users/canonicalorg"]);
});

Deno.test("owner resolution verifies a personal owner against the authenticated user", async () => {
  const requests: string[] = [];
  const client = new FetchGitHubClient({
    token: "test",
    fetch: (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      return Promise.resolve(
        Response.json(
          path === "/user"
            ? { login: "Kralizek", type: "User" }
            : { login: "kralizek", type: "User" },
        ),
      );
    },
  });

  assertEquals(await resolveRepositoryOwner(client, "kralizek"), {
    login: "kralizek",
    type: "User",
  });
  assertEquals(requests, ["/users/kralizek", "/user"]);
});

Deno.test("owner resolution rejects another personal account", async () => {
  const client = new FetchGitHubClient({
    token: "test",
    fetch: (input) =>
      Promise.resolve(
        Response.json(
          new URL(String(input)).pathname === "/user"
            ? { login: "authenticated", type: "User" }
            : { login: "other", type: "User" },
        ),
      ),
  });

  await assertRejects(
    () => resolveRepositoryOwner(client, "other"),
    RepositoryOwnerResolutionError,
    "not the authenticated GitHub user",
  );
});

Deno.test("owner resolution rejects missing and unexpected owner identities", async () => {
  const missing = new FetchGitHubClient({
    token: "test",
    fetch: () =>
      Promise.resolve(
        Response.json({ message: "Not Found" }, { status: 404 }),
      ),
  });
  await assertRejects(
    () => resolveRepositoryOwner(missing, "missing"),
    RepositoryOwnerResolutionError,
    "could not be resolved",
  );

  const unexpected = new FetchGitHubClient({
    token: "test",
    fetch: () =>
      Promise.resolve(Response.json({ login: "strange", type: "Bot" })),
  });
  await assertRejects(
    () => resolveRepositoryOwner(unexpected, "strange"),
    RepositoryOwnerResolutionError,
    "unsupported type",
  );
});
