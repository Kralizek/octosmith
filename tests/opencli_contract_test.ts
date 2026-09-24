import { assertEquals, assertStringIncludes } from "@std/assert";
import { usage, VERSION } from "../packages/cli/mod.ts";

interface OpenCliOption {
  readonly name: string;
  readonly aliases?: readonly string[];
}

interface OpenCliCommand {
  readonly name: string;
  readonly options?: readonly OpenCliOption[];
}

Deno.test("OpenCLI contract tracks the implemented root command surface", async () => {
  const document = JSON.parse(
    await Deno.readTextFile("opencli.json"),
  ) as {
    readonly opencli: string;
    readonly info: { readonly version: string };
    readonly commands: readonly OpenCliCommand[];
  };

  assertEquals(document.opencli, "0.1.0");
  assertEquals(document.info.version, VERSION);
  assertEquals(
    document.commands.map((command) => command.name),
    ["plan", "apply", "resource", "template"],
  );

  const help = usage();
  for (const command of document.commands) {
    assertStringIncludes(help, command.name);
  }
});

Deno.test("OpenCLI contract reserves -v for verbose and omits a short version alias", async () => {
  const document = JSON.parse(
    await Deno.readTextFile("opencli.json"),
  ) as {
    readonly options: readonly OpenCliOption[];
    readonly commands: readonly OpenCliCommand[];
  };

  assertEquals(
    document.options.some((option) => option.name === "--version"),
    true,
  );
  assertEquals(
    document.options.some((option) =>
      option.name === "--version" && option.aliases?.includes("-V")
    ),
    false,
  );

  for (
    const command of document.commands.filter((command) =>
      command.name === "plan" || command.name === "apply"
    )
  ) {
    assertEquals(
      command.options?.some((option) =>
        option.name === "--verbose" && option.aliases?.includes("-v")
      ),
      true,
    );
  }
});
