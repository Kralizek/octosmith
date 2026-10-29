import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  applyPlan,
  buildPlan,
  inspectResource,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  type PostCreateCommand,
  resolveDesiredState,
  runPostCreateCommand,
  toSchemaCompatibleRepositoryTemplate,
  validateConfigurationDirectory,
  validateConfigurationDirectoryDetailed,
} from "@octosmith/octosmith";
import { currentState } from "./plan/fixtures.ts";

async function configuration(
  commands: unknown,
  fragmentCommands?: unknown,
): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "templates"));
  await Deno.writeTextFile(
    join(root, "octosmith.yml"),
    JSON.stringify({
      version: 1,
      organization: "acme",
      repositories: { scope: { include: "all" } },
    }),
  );
  if (fragmentCommands !== undefined) {
    await Deno.writeTextFile(
      join(root, "base.yml"),
      JSON.stringify({
        version: 1,
        kind: "fragment",
        resource: "repository",
        repository: { post_create_commands: fragmentCommands },
      }),
    );
    await Deno.writeTextFile(
      join(root, "later.yml"),
      JSON.stringify({
        version: 1,
        kind: "fragment",
        resource: "repository",
        includes: ["base.yml"],
        repository: { post_create_commands: [{ command: "later" }] },
      }),
    );
  }
  await Deno.writeTextFile(
    join(root, "templates", "service.yml"),
    JSON.stringify({
      version: 1,
      kind: "repository",
      match: { include: "all" },
      ...(fragmentCommands !== undefined && {
        includes: ["../base.yml", "../later.yml"],
      }),
      repository: {
        ...(commands !== undefined && { post_create_commands: commands }),
      },
    }),
  );
  return root;
}

Deno.test("structured commands preserve order, default args and schema round-trip", async () => {
  const commands = [
    { command: "dotnet", args: ["new", "editorconfig"] },
    { command: "dotnet", args: ["new", "globaljson"] },
    { command: "/path with spaces/generator" },
    {
      command: "literal",
      args: ["", "$VAR", "%VAR%", "a;b", "$(not-a-shell)"],
    },
  ];
  const root = await configuration(commands);
  try {
    const loaded = await loadConfigurationDirectory(root);
    const template = loaded.templates["repository:service"];
    const expected = commands.map(({ command, args = [] }) => ({
      command,
      args,
    }));
    assertEquals(template.repository.postCreateCommands, expected);
    assertEquals(
      toSchemaCompatibleRepositoryTemplate(template).repository,
      { post_create_commands: expected },
    );
    assertEquals(await validateConfigurationDirectory(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (
  const [name, commands] of Object.entries({
    scalar: "dotnet new editorconfig",
    scalarEntry: ["dotnet new editorconfig"],
    missingCommand: [{}],
    emptyCommand: [{ command: "" }],
    whitespaceCommand: [{ command: " \t" }],
    numericCommand: [{ command: 42 }],
    nullEntry: [null],
    numericArgs: [{ command: "dotnet", args: [42] }],
    nullArgs: [{ command: "dotnet", args: null }],
    stringArgs: [{ command: "dotnet", args: "new editorconfig" }],
    unknownProperty: [{ command: "dotnet", shell: true }],
    runtimeCondition: [{ command: "dotnet", when: "create" }],
    environmentInjection: [{ command: "dotnet", env: { SECRET: "value" } }],
  })
) {
  for (const fragment of [false, true]) {
    Deno.test(`command schema rejects ${name} in ${fragment ? "fragment" : "template"}`, async () => {
      const root = await configuration(
        fragment ? undefined : commands,
        fragment ? commands : undefined,
      );
      try {
        await assertRejects(
          () => loadConfigurationDirectory(root),
          Error,
          "Invalid configuration",
        );
        assert(
          (await validateConfigurationDirectoryDetailed(root)).issues.length >
            0,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}

for (
  const commands of [
    undefined,
    [],
    [{ command: "template-first" }, { command: "template-second" }],
  ]
) {
  Deno.test(`command composition replaces whole lists, including empty: ${JSON.stringify(commands)}`, async () => {
    const root = await configuration(commands, [{ command: "base" }]);
    try {
      const loaded = await loadConfigurationDirectory(root);
      assertEquals(
        loaded.templates["repository:service"].repository.postCreateCommands,
        (commands ?? [{ command: "later" }]).map(({ command }) => ({
          command,
          args: [],
        })),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test({
  name:
    "ordinary desired-state resolution and planning ignore creation commands",
  permissions: {
    run: false,
    net: false,
    write: false,
    env: false,
    read: false,
  },
  fn: async () => {
    const postCreateCommands: readonly PostCreateCommand[] = [{
      command: "not-an-installed-tool",
      args: ["PRIVATE-ARGUMENT", "${NO_EXPANSION}"],
    }];
    const loaded: LoadedConfiguration = {
      root: ".",
      configuration: {
        version: 1,
        organization: "acme",
        repositories: { scope: { include: "all" } },
      },
      templates: {
        "repository:service": {
          version: 1,
          kind: "repository",
          match: { include: "all" },
          repository: { postCreateCommands, settings: { hasIssues: false } },
        },
      },
    };
    const desired = await resolveDesiredState(
      loaded,
      { name: "sample", teams: [], visibility: "private", properties: {} },
      () => {
        throw new Error("Must not resolve runtime values");
      },
    );
    assertEquals(desired, {
      repository: "sample",
      template: "repository:service",
      collections: "explicit",
      settings: { hasIssues: false },
    });
    const plan = buildPlan(currentState(), desired);
    assertEquals(plan.operations.length, 1);
    let applied = 0;
    const result = await applyPlan({
      apply: () => {
        applied++;
        return Promise.resolve();
      },
    }, plan);
    assertEquals(applied, 1);
    assertEquals(result.operations[0].status, "applied");
    assert(
      !JSON.stringify({ desired, plan, result }).includes("PRIVATE-ARGUMENT"),
    );
    assertEquals(
      inspectResource(loaded, {
        name: "sample",
        teams: [],
        properties: {},
      }).status,
      "matched",
    );
  },
});

Deno.test({
  name: "configuration validation never executes or probes create-only tools",
  permissions: { run: false, net: false, write: false, env: false, read: true },
  fn: async () => {
    const result = await validateConfigurationDirectoryDetailed(
      "tests/fixtures/creation-preview",
    );
    assertEquals(result.issues, []);
  },
});

Deno.test("native command runner passes literal arguments, null stdin and captures output", async () => {
  const root = await Deno.makeTempDir();
  try {
    const args = [
      "$(echo injected)",
      "$HOME",
      "%PATH%",
      "a;b",
      "a b",
      '"q"',
      "",
    ];
    const output = await runPostCreateCommand({
      command: Deno.execPath(),
      cwd: root,
      args: [
        "eval",
        'console.log(JSON.stringify({args:Deno.args,cwd:Deno.cwd(),stdin:await Deno.stdin.read(new Uint8Array(1))})); console.error("PRIVATE-STDERR");',
        ...args,
      ],
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        ...(Deno.build.os === "windows" &&
          { SYSTEMROOT: Deno.env.get("SYSTEMROOT") ?? "" }),
      },
    });
    assertEquals(output.code, 0);
    assertEquals(JSON.parse(output.stdout), {
      args,
      cwd: await Deno.realPath(root),
      stdin: null,
    });
    assert(output.stderr.includes("PRIVATE-STDERR"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
