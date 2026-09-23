import { assertEquals, assertRejects } from "@std/assert";
import { FetchGitHubClient } from "@octosmith/octosmith";

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

Deno.test("GitHub client omits content-type for GET requests", async () => {
  let contentType: string | null | undefined;
  let requestedVersion: string | null | undefined;

  const client = new FetchGitHubClient({
    token: "token",
    fetch: (_, init) => {
      const headers = new Headers(init?.headers);
      contentType = headers.get("content-type");
      requestedVersion = headers.get("x-github-api-version");
      return Promise.resolve(
        new Response(JSON.stringify({ name: "api" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  await client.get("/repos/acme/api");

  assertEquals(contentType, null);
  assertEquals(requestedVersion, "2026-03-10");
});

Deno.test("GitHub client adds content-type for JSON request bodies", async () => {
  let contentType: string | null | undefined;
  let requestedBody: string | undefined;

  const client = new FetchGitHubClient({
    token: "token",
    fetch: (_, init) => {
      contentType = new Headers(init?.headers).get("content-type");
      requestedBody = typeof init?.body === "string" ? init.body : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ name: "api" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });

  await client.request("PATCH", "/repos/acme/api", {
    body: { has_issues: false },
  });

  assertEquals(contentType, "application/json");
  assertEquals(requestedBody, JSON.stringify({ has_issues: false }));
});

Deno.test("GitHub client throws on an ordinary 404", async () => {
  const client = responseClient(
    new Response("missing", {
      status: 404,
      statusText: "Not Found",
    }),
  );

  await assertRejects(
    () => client.get("/repos/acme/missing"),
    Error,
    "404 Not Found - missing",
  );
});

Deno.test("GitHub client returns undefined for an allowed 404", async () => {
  const client = responseClient(
    new Response("missing", {
      status: 404,
      statusText: "Not Found",
    }),
  );

  assertEquals(
    await client.request("GET", "/repos/acme/missing", {
      allowNotFound: true,
    }),
    undefined,
  );
});

Deno.test("GitHub client propagates a 403 response", async () => {
  const client = responseClient(
    new Response("forbidden", {
      status: 403,
      statusText: "Forbidden",
    }),
  );

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

Deno.test("GitHub client traces API-relative endpoints and statuses", async () => {
  const traces: {
    method: string;
    path: string;
    status: number;
  }[] = [];

  const responses = [
    new Response(JSON.stringify({ name: "api" }), { status: 200 }),
    new Response("missing", { status: 404, statusText: "Not Found" }),
    new Response("forbidden", { status: 403, statusText: "Forbidden" }),
  ];

  const client = new FetchGitHubClient({
    token: "token",
    baseUrl: "https://github.example.com/api/v3",
    fetch: () => Promise.resolve(responses.shift()!.clone()),
    trace: (entry) => traces.push(entry),
  });

  await client.get("/repos/acme/api?embedded=do-not-log#fragment", { page: 2 });
  assertEquals(
    await client.request("GET", "/repos/acme/missing", {
      query: { token_like_query: "do-not-log" },
      allowNotFound: true,
    }),
    undefined,
  );
  await assertRejects(
    () => client.get("/repos/acme/private"),
    Error,
    "403 Forbidden",
  );

  assertEquals(traces, [
    { method: "GET", path: "/repos/acme/api", status: 200 },
    { method: "GET", path: "/repos/acme/missing", status: 404 },
    { method: "GET", path: "/repos/acme/private", status: 403 },
  ]);
});

function responseClient(response: Response): FetchGitHubClient {
  return new FetchGitHubClient({
    token: "token",
    fetch: () => Promise.resolve(response.clone()),
  });
}
