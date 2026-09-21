import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { parse } from "@std/yaml";
import {
  loadConfigurationDirectory,
  validateConfigurationDirectory,
} from "../packages/octosmith/mod.ts";
import {
  buildScaffold,
  parseScaffoldArguments,
  writeScaffold,
} from "../packages/octosmith/create/mod.ts";

Deno.test("create scaffolder uses conservative defaults", () => {
  const options = parseScaffoldArguments(
    ["github-config", "--organization", "acme"],
    () => null,
  );

  assertEquals(options, {
    targetDirectory: "github-config",
    organization: "acme",
    collectionManagement: "explicit",
    defaultBranch: "main",
    workflows: true,
    eventStreaming: false,
  });

  const files = buildScaffold(options);
  const configuration = files.find((file) => file.path === "octosmith.yml");
  const template = files.find((file) => file.path === "templates/default.yml");

  assertStringIncludes(
    configuration?.content ?? "",
    'names:\n      - "github-config"',
  );
  assertStringIncludes(
    configuration?.content ?? "",
    'collection_management: "explicit"',
  );
  assertStringIncludes(template?.content ?? "", "repository: {}");
});

Deno.test("create scaffolder supports non-interactive options", () => {
  const options = parseScaffoldArguments([
    "control",
    "--organization",
    "acme",
    "--collection-management",
    "strict",
    "--default-branch",
    "trunk",
    "--no-workflows",
    "--event-streaming",
  ]);

  assertEquals(options.collectionManagement, "strict");
  assertEquals(options.defaultBranch, "trunk");
  assertEquals(options.workflows, false);
  assertEquals(options.eventStreaming, true);
});

Deno.test("create scaffolder prompts for missing organization", () => {
  const options = parseScaffoldArguments(["control"], () => "acme");

  assertEquals(options.organization, "acme");
});

Deno.test("create scaffolder trims organization input", () => {
  const options = parseScaffoldArguments([
    "control",
    "--organization",
    "  acme  ",
  ]);

  assertEquals(options.organization, "acme");
});

Deno.test("create scaffolder rejects invalid management mode", () => {
  assertThrows(
    () =>
      parseScaffoldArguments([
        "--organization",
        "acme",
        "--collection-management",
        "aggressive",
      ]),
    Error,
    "explicit or strict",
  );
});

Deno.test("generated scaffold validates as OctoSmith configuration", async () => {
  const root = await Deno.makeTempDir();

  try {
    const target = join(root, "github-config");
    await writeScaffold({
      targetDirectory: target,
      organization: "acme",
      collectionManagement: "explicit",
      defaultBranch: "main",
      workflows: true,
      eventStreaming: false,
    });

    const loaded = await loadConfigurationDirectory(target);
    assertEquals(loaded.configuration.organization, "acme");
    await validateConfigurationDirectory(target);

    const validateWorkflow = await Deno.readTextFile(
      join(target, ".github/workflows/octosmith-validate.yml"),
    );
    const applyWorkflow = await Deno.readTextFile(
      join(target, ".github/workflows/octosmith-apply.yml"),
    );

    assertStringIncludes(validateWorkflow, "pull_request:");
    assertStringIncludes(validateWorkflow, "persist-credentials: false");
    assertStringIncludes(validateWorkflow, "uses: Kralizek/octosmith@v0");
    assertStringIncludes(validateWorkflow, "mode: validate");
    assertEquals(validateWorkflow.includes("OCTOSMITH_TOKEN"), false);
    assertEquals(validateWorkflow.includes("github-token:"), false);
    assertStringIncludes(applyWorkflow, "mode: apply");
    assertStringIncludes(applyWorkflow, '- "main"');
    assertStringIncludes(applyWorkflow, "group: octosmith-apply");
    assertStringIncludes(applyWorkflow, "cancel-in-progress: false");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("create scaffolder serializes interpolated YAML scalars", () => {
  const files = buildScaffold({
    targetDirectory: "true",
    organization: "false",
    collectionManagement: "explicit",
    defaultBranch: "release:next",
    workflows: true,
    eventStreaming: false,
  });

  const configurationFile = files.find((file) => file.path === "octosmith.yml");
  const applyWorkflowFile = files.find((file) =>
    file.path === ".github/workflows/octosmith-apply.yml"
  );

  const configuration = parse(configurationFile?.content ?? "") as Record<
    string,
    unknown
  >;
  const repositories = configuration.repositories as Record<string, unknown>;
  const scope = repositories.scope as Record<string, unknown>;

  assertEquals(configuration.organization, "false");
  assertEquals(scope.names, ["true"]);

  const applyWorkflow = parse(applyWorkflowFile?.content ?? "") as Record<
    string,
    unknown
  >;
  const trigger = applyWorkflow.on as Record<string, unknown>;
  const push = trigger.push as Record<string, unknown>;

  assertEquals(push.branches, ["release:next"]);
});

Deno.test("create scaffolder documents manual mode without workflows", () => {
  const files = buildScaffold({
    targetDirectory: "control",
    organization: "acme",
    collectionManagement: "explicit",
    defaultBranch: "main",
    workflows: false,
    eventStreaming: true,
  });

  assertEquals(
    files.some((file) => file.path.startsWith(".github/workflows/")),
    false,
  );
  assertEquals(
    files.some((file) => file.path === "hooksmith.config.ts"),
    true,
  );

  const readme = files.find((file) => file.path === "README.md");
  assertStringIncludes(readme?.content ?? "", "--no-workflows");
  assertStringIncludes(readme?.content ?? "", "--event-streaming");
  assertStringIncludes(readme?.content ?? "", "Hooksmith");
  assertStringIncludes(
    readme?.content ?? "",
    "Set `GITHUB_TOKEN` before running plan or apply locally",
  );
});

Deno.test("event streaming generates Hooksmith FIFO orchestration", () => {
  const files = buildScaffold({
    targetDirectory: "control",
    organization: "acme",
    collectionManagement: "explicit",
    defaultBranch: "main",
    workflows: true,
    eventStreaming: true,
  });

  const hooksmith = files.find((file) => file.path === "hooksmith.config.ts");
  const applyWorkflow = files.find((file) =>
    file.path === ".github/workflows/octosmith-apply.yml"
  );
  const readme = files.find((file) => file.path === "README.md");

  assertStringIncludes(
    hooksmith?.content ?? "",
    'eventType("resource.applied")',
  );
  assertStringIncludes(
    hooksmith?.content ?? "",
    'subjectKind("github.repository")',
  );
  assertStringIncludes(hooksmith?.content ?? "", "listeners: [logEvent()]");

  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "persist-credentials: false",
  );
  assertStringIncludes(applyWorkflow?.content ?? "", "mkfifo");
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "jsr:@hooksmith/cli stream",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "group: octosmith-apply",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "cancel-in-progress: false",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "env -u GITHUB_TOKEN deno run -A jsr:@hooksmith/cli stream",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "OCTOSMITH_GITHUB_TOKEN: ${{ secrets.OCTOSMITH_TOKEN }}",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    'GITHUB_TOKEN="$OCTOSMITH_GITHUB_TOKEN"',
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "jsr:@octosmith/cli@0 apply",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    '--events-output "$events_pipe"',
  );
  assertStringIncludes(applyWorkflow?.content ?? "", "hooksmith_pid=$!");
  assertStringIncludes(applyWorkflow?.content ?? "", "octosmith_pid=$!");
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    "wait -n -p completed_pid",
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    'wait "$octosmith_pid"',
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    'exit "$octosmith_status"',
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    'kill "$octosmith_pid" 2>/dev/null || true',
  );
  assertStringIncludes(
    applyWorkflow?.content ?? "",
    'kill "$hooksmith_pid" 2>/dev/null || true',
  );

  assertStringIncludes(readme?.content ?? "", "Event streaming with Hooksmith");
  assertStringIncludes(readme?.content ?? "", "local FIFO");
});

Deno.test("create scaffolder does not overwrite non-empty targets", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.writeTextFile(join(root, "keep.txt"), "keep");

    await assertRejects(
      () =>
        writeScaffold({
          targetDirectory: root,
          organization: "acme",
          collectionManagement: "explicit",
          defaultBranch: "main",
          workflows: false,
          eventStreaming: false,
        }),
      Error,
      "not empty",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("create scaffolder infers repository name in current directory", async () => {
  const previousWorkingDirectory = Deno.cwd();
  const root = await Deno.makeTempDir();
  const project = join(root, "control-repo");

  try {
    await Deno.mkdir(project);
    Deno.chdir(project);

    const files = buildScaffold({
      targetDirectory: ".",
      organization: "acme",
      collectionManagement: "explicit",
      defaultBranch: "main",
      workflows: false,
      eventStreaming: false,
    });

    const configuration = files.find((file) => file.path === "octosmith.yml");
    assertStringIncludes(
      configuration?.content ?? "",
      'names:\n      - "control-repo"',
    );
  } finally {
    Deno.chdir(previousWorkingDirectory);
    await Deno.remove(root, { recursive: true });
  }
});
