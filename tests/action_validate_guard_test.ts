import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

Deno.test("action validate preflights untrusted file sources before CLI validation", async () => {
  const root = await Deno.makeTempDir();

  try {
    const bin = join(root, "bin");
    const capture = join(root, "invocations.txt");
    await Deno.mkdir(bin);

    const deno = join(bin, "deno");
    await Deno.writeTextFile(
      deno,
      `#!/usr/bin/env bash
printf '%s\\n' '---' "$@" >> "$OCTOSMITH_TEST_INVOCATIONS"
`,
    );
    await Deno.chmod(deno, 0o755);

    const output = await new Deno.Command("bash", {
      args: ["scripts/run-action.sh"],
      env: {
        GITHUB_ACTION_PATH: Deno.cwd(),
        OCTOSMITH_MODE: "validate",
        OCTOSMITH_PATH: "./configuration",
        OCTOSMITH_TEST_INVOCATIONS: capture,
        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0);

    const invocations = await Deno.readTextFile(capture);
    const guard = `${Deno.cwd()}/scripts/validate-file-sources.ts`;
    const cli = `${Deno.cwd()}/packages/cli/mod.ts`;
    const guardIndex = invocations.indexOf(guard);
    const cliIndex = invocations.indexOf(cli);

    assertStringIncludes(invocations, guard);
    assertStringIncludes(invocations, cli);
    assertEquals(guardIndex < cliIndex, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
