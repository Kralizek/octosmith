import { assertEquals, assertStringIncludes } from "@std/assert";
import { main, usage, VERSION } from "./mod.ts";

Deno.test("usage identifies Octosmith", () => {
  assertStringIncludes(usage(), "octosmith");
  assertStringIncludes(usage(), "plan");
  assertStringIncludes(usage(), "apply");
  assertStringIncludes(usage(), "template");
  assertStringIncludes(usage(), "resource");
  assertEquals(usage().includes("-v, --version"), false);
});

Deno.test("version comes from package metadata", async () => {
  const metadata = JSON.parse(
    await Deno.readTextFile(new URL("./deno.json", import.meta.url)),
  );

  assertEquals(VERSION, metadata.version);
});

Deno.test("missing gh returns a clear CLI failure", async () => {
  const errors: string[] = [];
  let fetchCalls = 0;

  assertEquals(
    await main(["plan"], {
      credentials: {
        getEnv: () => undefined,
        runGhAuthToken: () =>
          Promise.reject(new Deno.errors.NotFound("secret")),
      },
      fetch: () => {
        fetchCalls++;
        throw new Error("fetch must not be called");
      },
      writeError: (value) => errors.push(value),
    }),
    1,
  );
  assertStringIncludes(errors.join("\n"), "gh is not installed");
  assertEquals(errors.join("\n").includes("secret"), false);
  assertEquals(fetchCalls, 0);
});

Deno.test("resource list uses the GitHub CLI token without leaking it", async () => {
  const root = await authenticationConfiguration();
  const output: string[] = [];
  const errors: string[] = [];
  const authorizations: string[] = [];
  try {
    assertEquals(
      await main(["resource", "list", "--path", root], {
        credentials: {
          getEnv: () => undefined,
          runGhAuthToken: () =>
            Promise.resolve({
              code: 0,
              success: true,
              signal: null,
              stdout: new TextEncoder().encode(" cli-secret\n"),
              stderr: new Uint8Array(),
            }),
        },
        fetch: (_url, init) => {
          authorizations.push(
            (init?.headers as Record<string, string>).authorization,
          );
          return Promise.resolve(Response.json([]));
        },
        write: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      }),
      0,
      errors.join("\n"),
    );
    assertEquals(authorizations.map((header) => header.slice(7)), [
      "cli-secret",
    ]);
    assertEquals(authorizations[0].startsWith("Bearer "), true);
    assertStringIncludes(output.join("\n"), "0 matched, 0 unmatched");
    assertEquals(output.join("\n").includes("cli-secret"), false);
    assertEquals(errors.join("\n").includes("cli-secret"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed gh token retrieval fails the CLI without exposing output", async () => {
  const errors: string[] = [];
  assertEquals(
    await main(["resource", "list"], {
      credentials: {
        getEnv: () => undefined,
        runGhAuthToken: () =>
          Promise.resolve({
            code: 2,
            success: false,
            signal: null,
            stdout: new TextEncoder().encode("cli-secret"),
            stderr: new TextEncoder().encode("cli-secret"),
          }),
      },
      writeError: (value) => errors.push(value),
    }),
    1,
  );
  assertStringIncludes(errors.join("\n"), "gh auth token exited with code 2");
  assertEquals(errors.join("\n").includes("cli-secret"), false);
});

Deno.test("offline commands do not read credentials or invoke gh", async () => {
  const root = await authenticationConfiguration();
  try {
    const credentials = {
      getEnv: () => {
        throw new Error("environment must not be read");
      },
      runGhAuthToken: () => {
        throw new Error("gh must not be invoked");
      },
    };
    for (const command of ["validate", "permissions"]) {
      const errors: string[] = [];
      assertEquals(
        await main(["template", command, "--path", root], {
          credentials,
          write: () => {},
          writeError: (value) => errors.push(value),
        }),
        0,
        errors.join("\n"),
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function authenticationConfiguration(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/templates`);
  await Deno.writeTextFile(
    `${root}/octosmith.yml`,
    "version: 1\norganization: acme\nrepositories:\n  scope:\n    include: all\n",
  );
  await Deno.writeTextFile(
    `${root}/templates/sample.yml`,
    "version: 1\nkind: repository\nmatch:\n  include: all\nrepository: {}\n",
  );
  return root;
}

Deno.test("apply rejects combining a resource target with --plan", async () => {
  const errors: string[] = [];
  const originalError = console.error;

  try {
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };

    assertEquals(await main(["apply", "sample", "--plan", "plan.json"]), 1);
    assertStringIncludes(
      errors.join("\n"),
      "Cannot combine a resource target with --plan",
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("version is available from grouped commands without a short alias", async () => {
  const output: string[] = [];
  const originalLog = console.log;

  try {
    console.log = (...values: unknown[]) =>
      output.push(values.map(String).join(" "));
    assertEquals(await main(["template", "--version"]), 0);
    assertStringIncludes(output.join("\n"), VERSION);
  } finally {
    console.log = originalLog;
  }
});

for (
  const [name, args, message] of [
    [
      "resource create",
      ["resource", "create", "teams/backend", "--name", "api-service"],
      "resource create is not implemented yet",
    ],
    [
      "template validate target",
      ["template", "validate", "teams/backend"],
      "Template-specific validation is not implemented yet",
    ],
  ] as const
) {
  Deno.test(`canonical CLI form parses: ${name}`, async () => {
    const errors: string[] = [];
    const originalError = console.error;

    try {
      console.error = (...values: unknown[]) => {
        errors.push(values.map(String).join(" "));
      };

      assertEquals(await main([...args]), 1);
      assertStringIncludes(errors.join("\n"), message);
    } finally {
      console.error = originalError;
    }
  });
}
