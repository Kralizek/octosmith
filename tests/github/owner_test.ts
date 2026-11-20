import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertOrganizationOwner,
  FetchGitHubClient,
  GitHubOwnerError,
  resolveGitHubOwner,
  resolveGitHubOwnerContext,
} from "@octosmith/octosmith";

Deno.test("owner resolution uses the API's canonical identity and account type", async () => {
  for (const type of ["Organization", "User"] as const) {
    const paths: string[] = [];
    const client = new FetchGitHubClient({
      token: "test",
      fetch: (input) => {
        paths.push(new URL(String(input)).pathname);
        return Promise.resolve(Response.json({ login: "Acme", type }));
      },
    });

    const owner = await resolveGitHubOwner(client, "acme");
    assertEquals(owner, { login: "Acme", type });
    assertEquals(paths, ["/users/acme"]);
    if (type === "Organization") {
      assertOrganizationOwner(owner);
    } else {
      assertThrows(
        () => assertOrganizationOwner(owner),
        GitHubOwnerError,
        'GitHub owner "Acme" is a personal account (User)',
      );
    }
  }
});

Deno.test("personal owner context requires matching authenticated user", async () => {
  const paths: string[] = [];
  const client = new FetchGitHubClient({
    token: "test",
    fetch: (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Promise.resolve(
        Response.json(
          path === "/users/alice"
            ? { login: "Alice", type: "User" }
            : { login: "alice" },
        ),
      );
    },
  });
  const owner = await resolveGitHubOwnerContext(client, {
    login: "alice",
    type: "User",
  });
  assertEquals(owner.login, "Alice");
  assertEquals(owner.capabilities.teams, false);
  assertEquals(paths, ["/users/alice", "/user"]);

  const mismatched = new FetchGitHubClient({
    token: "test",
    fetch: (input) =>
      Promise.resolve(
        Response.json(
          new URL(String(input)).pathname === "/users/alice"
            ? { login: "Alice", type: "User" }
            : { login: "Mallory" },
        ),
      ),
  });
  await assertRejects(
    () =>
      resolveGitHubOwnerContext(mismatched, {
        login: "alice",
        type: "User",
      }),
    GitHubOwnerError,
    "Personal repositories can only be provisioned for the authenticated user",
  );
});

Deno.test("owner resolution rejects unexpected types and malformed identities", async () => {
  for (
    const response of [
      { login: "acme", type: "Bot" },
      { login: "acme" },
      { type: "Organization" },
      { login: "", type: "Organization" },
      null,
    ]
  ) {
    const client = new FetchGitHubClient({
      token: "test",
      fetch: () => Promise.resolve(Response.json(response)),
    });
    await assertRejects(
      () => resolveGitHubOwner(client, "acme"),
      GitHubOwnerError,
      "changes were applied",
    );
  }
});

Deno.test("owner API failures fail closed with safe actionable diagnostics", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const client = new FetchGitHubClient({
      token: "test",
      fetch: () =>
        Promise.resolve(Response.json({ message: "PRIVATE-API-BODY" }, {
          status,
        })),
    });
    const error = await assertRejects(
      () => resolveGitHubOwner(client, "missing"),
      GitHubOwnerError,
      `Cannot resolve configured GitHub owner "missing" (HTTP ${status})`,
    );
    assertEquals(error.httpStatus, status);
    assertEquals(error.message.includes("PRIVATE-API-BODY"), false);
  }
  const client = new FetchGitHubClient({
    token: "test",
    fetch: () => Promise.reject(new Error("PRIVATE-NETWORK-DETAILS")),
  });
  await assertRejects(
    () => resolveGitHubOwner(client, "acme"),
    GitHubOwnerError,
    "Check organization spelling, authentication, API connectivity and access",
  );
});
