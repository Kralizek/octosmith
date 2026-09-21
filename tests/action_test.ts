import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml";

Deno.test("action metadata delegates to the CLI package", async () => {
  const action = parse(await Deno.readTextFile("action.yml")) as Record<
    string,
    unknown
  >;
  const runs = action.runs as Record<string, unknown>;
  const steps = runs.steps as readonly Record<string, unknown>[];

  assertEquals(runs.using, "composite");
  assertEquals(
    steps.some((step) => step.uses === "denoland/setup-deno@v2"),
    true,
  );

  const runStep = steps.find((step) => step.name === "Run OctoSmith");
  assertStringIncludes(
    String(runStep?.run ?? ""),
    "$GITHUB_ACTION_PATH/scripts/run-action.sh",
  );

  const script = await Deno.readTextFile("scripts/run-action.sh");
  assertStringIncludes(script, "$GITHUB_ACTION_PATH/packages/cli/mod.ts");
  assertEquals(script.includes("$GITHUB_ACTION_PATH/action/mod.ts"), false);
  assertEquals(script.includes("jsr:@octosmith/cli"), false);
});

Deno.test("action wrapper maps trimmed inputs to CLI arguments", async () => {
  const result = await runActionWrapper({
    OCTOSMITH_MODE: " apply ",
    OCTOSMITH_PATH: " ./configuration ",
    OCTOSMITH_REPOSITORY: " api-service ",
    OCTOSMITH_FORMAT: " json ",
    OCTOSMITH_VERBOSE: " TrUe ",
    OCTOSMITH_EVENTS_OUTPUT: " /tmp/octosmith-events ",
  });

  assertEquals(result.code, 0);
  assertEquals(result.args, [
    "run",
    "--config",
    `${Deno.cwd()}/deno.json`,
    "-A",
    `${Deno.cwd()}/packages/cli/mod.ts`,
    "apply",
    "api-service",
    "--path",
    "./configuration",
    "--format",
    "json",
    "--verbose",
    "--events-output",
    "/tmp/octosmith-events",
  ]);
});

Deno.test("action wrapper supports offline validate", async () => {
  const result = await runActionWrapper({
    OCTOSMITH_MODE: "validate",
  });

  assertEquals(result.code, 0);
  assertEquals(result.args.slice(-5), [
    "validate",
    "--path",
    ".",
    "--format",
    "text",
  ]);
});

Deno.test("action wrapper defaults whitespace-only format to text", async () => {
  const result = await runActionWrapper({
    OCTOSMITH_MODE: "plan",
    OCTOSMITH_FORMAT: "   ",
  });

  assertEquals(result.code, 0);
  assertEquals(result.args.slice(-5), [
    "plan",
    "--path",
    ".",
    "--format",
    "text",
  ]);
});

Deno.test("action wrapper applies optional input defaults", async () => {
  const result = await runActionWrapper({
    OCTOSMITH_MODE: "plan",
  });

  assertEquals(result.code, 0);
  assertEquals(result.args.slice(-5), [
    "plan",
    "--path",
    ".",
    "--format",
    "text",
  ]);
});

Deno.test("action wrapper treats whitespace-only format as omitted", async () => {
  const result = await runActionWrapper({
    OCTOSMITH_MODE: "plan",
    OCTOSMITH_FORMAT: "   ",
  });

  assertEquals(result.code, 0);
  assertEquals(result.args.slice(-5), [
    "plan",
    "--path",
    ".",
    "--format",
    "text",
  ]);
});

for (
  const [name, env, message] of [
    [
      "mode",
      { OCTOSMITH_MODE: "invalid" },
      "mode must be 'validate', 'plan', or 'apply'",
    ],
    [
      "format",
      { OCTOSMITH_MODE: "plan", OCTOSMITH_FORMAT: "xml" },
      "format must be either 'text' or 'json'",
    ],
    [
      "verbose",
      { OCTOSMITH_MODE: "plan", OCTOSMITH_VERBOSE: "maybe" },
      "verbose must be either 'true' or 'false'",
    ],
  ] as const
) {
  Deno.test(`action wrapper rejects invalid ${name}`, async () => {
    const result = await runActionWrapper(env);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, message);
  });
}

async function runActionWrapper(
  env: Record<string, string>,
): Promise<{ code: number; args: string[]; stderr: string }> {
  const root = await Deno.makeTempDir();

  try {
    const bin = `${root}/bin`;
    const capture = `${root}/args.txt`;
    await Deno.mkdir(bin);

    const deno = `${bin}/deno`;
    await Deno.writeTextFile(
      deno,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$OCTOSMITH_TEST_ARGS"
`,
    );
    await Deno.chmod(deno, 0o755);

    const command = new Deno.Command("bash", {
      args: ["scripts/run-action.sh"],
      env: {
        ...env,
        GITHUB_ACTION_PATH: Deno.cwd(),
        OCTOSMITH_TEST_ARGS: capture,
        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
      },
      stdout: "piped",
      stderr: "piped",
    });

    const output = await command.output();
    const stderr = new TextDecoder().decode(output.stderr);
    let args: string[] = [];

    try {
      args = (await Deno.readTextFile(capture)).trimEnd().split("\n");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    return { code: output.code, args, stderr };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
