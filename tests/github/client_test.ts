import { assertEquals, assertRejects } from "@std/assert";
import { FetchGitHubClient } from "@octosmith/github";

Deno.test("GitHub client preserves a path in the configured base URL", async () => {
  let requestedUrl: string | undefined;

  const client = new FetchGitHubClient({
    token: "token",
    baseUrl: "https://github.example.com/api/v3",
    fetch: (input) => {
      requestedUrl = String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ name: "api" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  await client.get("/repos/acme/api");

  assertEquals(
    requestedUrl,
    "https://github.example.com/api/v3/repos/acme/api",
  );
});

Deno.test("GitHub client still resolves root API URLs", async () => {
  let requestedUrl: string | undefined;

  const client = new FetchGitHubClient({
    token: "token",
    fetch: (input) => {
      requestedUrl = String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ name: "api" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  await client.get("/repos/acme/api");

  assertEquals(requestedUrl, "https://api.github.com/repos/acme/api");
});


Deno.test("GitHub client throws on an ordinary 404", async () => {
  const client = responseClient(new Response("missing", {
    status: 404,
    statusText: "Not Found",
  }));

  await assertRejects(
    () => client.get("/repos/acme/missing"),
    Error,
    "404 Not Found - missing",
  );
});

Deno.test("GitHub client returns undefined for an allowed 404", async () => {
  const client = responseClient(new Response("missing", {
    status: 404,
    statusText: "Not Found",
  }));

  assertEquals(
    await client.request("GET", "/repos/acme/missing", {
      allowNotFound: true,
    }),
    undefined,
  );
});

Deno.test("GitHub client propagates a 403 response", async () => {
  const client = responseClient(new Response("forbidden", {
    status: 403,
    statusText: "Forbidden",
  }));

  await assertRejects(
    () => client.get("/repos/acme/private"),
    Error,
    "403 Forbidden - forbidden",
  );
});

Deno.test("GitHub client accepts a bodyless 204", async () => {
  const client = responseClient(new Response(null, { status: 204 }));

  assertEquals(
    await client.request("DELETE", "/repos/acme/api"),
    undefined,
  );
});

function responseClient(response: Response): FetchGitHubClient {
  return new FetchGitHubClient({
    token: "token",
    fetch: () => Promise.resolve(response.clone()),
  });
}
