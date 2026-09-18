import { assertEquals } from "@std/assert";
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
