import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { resolveGitHubToken } from "./auth.ts";

function output(code: number, stdout = "", stderr = ""): Deno.CommandOutput {
  const encoder = new TextEncoder();
  return {
    code,
    success: code === 0,
    signal: null,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  };
}

Deno.test("explicit token wins over environment and GitHub CLI", async () => {
  assertEquals(
    await resolveGitHubToken({
      explicitToken: " \texplicit-secret\n",
      getEnv: () => {
        throw new Error("environment must not be read");
      },
      runGhAuthToken: () => {
        throw new Error("gh must not be invoked");
      },
    }),
    "explicit-secret",
  );
});

Deno.test("GITHUB_TOKEN wins over GitHub CLI", async () => {
  assertEquals(
    await resolveGitHubToken({
      getEnv: (name) =>
        name === "GITHUB_TOKEN" ? " environment-secret\r\n" : "",
      runGhAuthToken: () => {
        throw new Error("gh must not be invoked");
      },
    }),
    "environment-secret",
  );
});

for (
  const [name, value] of [["empty", ""], ["whitespace-only", " \t"]] as const
) {
  Deno.test(`${name} GITHUB_TOKEN does not fall back to gh`, async () => {
    await assertRejects(
      () =>
        resolveGitHubToken({
          getEnv: (name) => name === "GITHUB_TOKEN" ? value : undefined,
          runGhAuthToken: () => {
            throw new Error("gh must not be invoked");
          },
        }),
      Error,
      "GITHUB_TOKEN is empty",
    );
  });
}

Deno.test("GitHub CLI token is trimmed before use", async () => {
  assertEquals(
    await resolveGitHubToken({
      getEnv: () => undefined,
      runGhAuthToken: (args) => {
        assertEquals(args, ["auth", "token", "--hostname", "github.com"]);
        return Promise.resolve(output(0, " \tcli-secret\r\n"));
      },
    }),
    "cli-secret",
  );
});

for (
  const [name, runGhAuthToken, diagnostic] of [
    [
      "missing gh",
      () => Promise.reject(new Deno.errors.NotFound("sensitive-detail")),
      "gh is not installed",
    ],
    [
      "unauthenticated gh",
      () =>
        Promise.resolve(
          output(
            1,
            "sensitive-detail",
            "You are not logged into any GitHub hosts. Run gh auth login to authenticate. sensitive-detail",
          ),
        ),
      "gh is not authenticated",
    ],
    [
      "failed gh",
      () => Promise.resolve(output(2, "sensitive-detail", "sensitive-detail")),
      "gh auth token exited with code 2",
    ],
    [
      "empty gh token",
      () => Promise.resolve(output(0, " \n\t")),
      "gh auth token returned an empty token",
    ],
  ] as const
) {
  Deno.test(`${name} produces a credential-safe error`, async () => {
    const error = await assertRejects(
      () =>
        resolveGitHubToken({
          getEnv: () => undefined,
          runGhAuthToken,
        }),
      Error,
      diagnostic,
    );
    assertEquals(error.message.includes("sensitive-detail"), false);
  });
}

Deno.test("explicit empty token is not silently replaced", async () => {
  await assertRejects(
    () =>
      resolveGitHubToken({
        explicitToken: " ",
        runGhAuthToken: () => {
          throw new Error("gh must not be invoked");
        },
      }),
    Error,
    "Explicit GitHub token is empty",
  );
});

for (
  const [name, value] of [
    ["true", "true"],
    ["false", "false"],
    ["empty", ""],
  ] as const
) {
  Deno.test(`GitHub Actions marker ${name} without a token does not invoke gh`, async () => {
    const error = await assertRejects(
      () =>
        resolveGitHubToken({
          getEnv: (name) => name === "GITHUB_ACTIONS" ? value : undefined,
          runGhAuthToken: () => {
            throw new Error("gh must not be invoked");
          },
        }),
      Error,
    );
    assertStringIncludes(error.message, "GITHUB_TOKEN is required");
  });
}
