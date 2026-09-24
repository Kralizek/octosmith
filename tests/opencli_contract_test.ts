import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml";
import { usage, VERSION } from "../packages/cli/mod.ts";

interface OpenCliFlag {
  readonly name: string;
  readonly aliases?: readonly string[];
}

interface OpenCliCommand {
  readonly kind?: "action" | "group";
  readonly flags?: readonly OpenCliFlag[];
  readonly examples?: readonly { readonly title: string; readonly content: string }[];
}

interface OpenCliExitCode {
  readonly code: number;
  readonly status: string;
}

interface OpenCliDocument {
  readonly opencliVersion: string;
  readonly info: {
    readonly binary: string;
    readonly version: string;
  };
  readonly global?: {
    readonly flags?: readonly OpenCliFlag[];
    readonly exitCodes?: readonly OpenCliExitCode[];
  };
  readonly commands: Readonly<Record<string, OpenCliCommand>>;
}

async function loadContract(): Promise<OpenCliDocument> {
  return parse(
    await Deno.readTextFile("opencli.ocs.yaml"),
  ) as OpenCliDocument;
}

Deno.test("OpenCLI contract tracks the implemented root command surface", async () => {
  const document = await loadContract();

  assertEquals(document.opencliVersion, "1.0.0-alpha.14");
  assertEquals(document.info.binary, "octosmith");
  assertEquals(document.info.version, VERSION);
  assertEquals(
    Object.keys(document.commands),
    [
      "octosmith plan",
      "octosmith apply",
      "octosmith resource",
      "octosmith resource list",
      "octosmith resource create",
      "octosmith template",
      "octosmith template validate",
      "octosmith template permissions",
    ],
  );

  const help = usage();
  for (const command of ["plan", "apply", "resource", "template"]) {
    assertStringIncludes(help, command);
  }
});

Deno.test("OpenCLI contract reserves -v for verbose and omits a short version alias", async () => {
  const document = await loadContract();
  const globalFlags = document.global?.flags ?? [];

  assertEquals(
    globalFlags.some((flag) => flag.name === "version"),
    true,
  );
  assertEquals(
    globalFlags.some((flag) =>
      flag.name === "version" && flag.aliases?.includes("V")
    ),
    false,
  );

  for (const commandName of ["octosmith plan", "octosmith apply"]) {
    const command = document.commands[commandName];
    assertEquals(
      command.flags?.some((flag) =>
        flag.name === "verbose" && flag.aliases?.includes("v")
      ),
      true,
    );
  }
});

Deno.test("OpenCLI contract gives resource list configuration and output flags", async () => {
  const document = await loadContract();
  const command = document.commands["octosmith resource list"];

  assertEquals(
    command.flags?.some((flag) =>
      flag.name === "path" && flag.aliases?.includes("p")
    ),
    true,
  );
  assertEquals(
    command.flags?.some((flag) => flag.name === "format"),
    true,
  );
});


Deno.test("OpenCLI contract documents help alias and current exit behavior", async () => {
  const document = await loadContract();
  const globalFlags = document.global?.flags ?? [];

  assertEquals(
    globalFlags.some((flag) =>
      flag.name === "help" && flag.aliases?.includes("h")
    ),
    true,
  );
  assertEquals(
    document.global?.exitCodes,
    [
      { code: 0, status: "OK" },
      { code: 1, status: "INTERNAL_CLI_ERROR" },
    ].map(({ code, status }) => ({ code, status })),
  );
});

Deno.test("OpenCLI contract includes representative canonical examples", async () => {
  const document = await loadContract();

  for (const commandName of [
    "octosmith plan",
    "octosmith apply",
    "octosmith resource create",
    "octosmith template validate",
  ]) {
    assertEquals(
      (document.commands[commandName].examples?.length ?? 0) > 0,
      true,
    );
  }
});
