import { basename, dirname, join } from "@std/path";
import type { CollectionManagementMode } from "../types.ts";

export interface ScaffoldOptions {
  readonly targetDirectory: string;
  readonly organization: string;
  readonly collectionManagement: CollectionManagementMode;
  readonly defaultBranch: string;
  readonly workflows: boolean;
  readonly eventStreaming: boolean;
}

export interface ScaffoldFile {
  readonly path: string;
  readonly content: string;
}

export function buildScaffold(
  options: ScaffoldOptions,
): readonly ScaffoldFile[] {
  const repositoryName = inferRepositoryName(options.targetDirectory);

  const files: ScaffoldFile[] = [
    {
      path: "octosmith.yml",
      content: `version: 1
organization: ${yamlScalar(options.organization)}
repositories:
  scope:
    names:
      - ${yamlScalar(repositoryName)}
  settings:
    collection_management: ${yamlScalar(options.collectionManagement)}
`,
    },
    {
      path: "templates/default.yml",
      content: `kind: repository
match:
  names:
    - ${yamlScalar(repositoryName)}
repository: {}
`,
    },
    {
      path: ".gitignore",
      content: ".DS_Store\n",
    },
    {
      path: "README.md",
      content: buildReadme(options, repositoryName),
    },
  ];

  if (options.eventStreaming) {
    files.push({
      path: "hooksmith.config.ts",
      content: buildHooksmithConfiguration(),
    });
  }

  if (options.workflows) {
    files.push(
      {
        path: ".github/workflows/octosmith-validate.yml",
        content: buildValidateWorkflow(),
      },
      {
        path: ".github/workflows/octosmith-apply.yml",
        content: buildApplyWorkflow(
          options.defaultBranch,
          options.eventStreaming,
        ),
      },
    );
  }

  return files;
}

export async function writeScaffold(
  options: ScaffoldOptions,
): Promise<void> {
  await ensureTargetDirectoryIsAvailable(options.targetDirectory);

  for (const file of buildScaffold(options)) {
    const path = join(options.targetDirectory, file.path);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, file.content);
  }
}

export function parseScaffoldArguments(
  args: readonly string[],
  promptOrganization: () => string | null = () =>
    prompt("GitHub organization:"),
): ScaffoldOptions {
  let targetDirectory = "github-config";
  let organization: string | undefined;
  let collectionManagement: CollectionManagementMode = "explicit";
  let defaultBranch = "main";
  let workflows = true;
  let eventStreaming = false;
  let targetAssigned = false;

  for (let index = 0; index < args.length; index++) {
    const value = args[index];

    if (!value.startsWith("-")) {
      if (targetAssigned) {
        throw new Error("Only one target directory may be specified");
      }

      targetDirectory = value;
      targetAssigned = true;
      continue;
    }

    switch (value) {
      case "--organization":
        organization = requireValue(args, ++index, value);
        break;
      case "--collection-management": {
        const mode = requireValue(args, ++index, value);
        if (mode !== "explicit" && mode !== "strict") {
          throw new Error(
            "--collection-management must be explicit or strict",
          );
        }
        collectionManagement = mode;
        break;
      }
      case "--default-branch":
        defaultBranch = requireValue(args, ++index, value);
        break;
      case "--no-workflows":
        workflows = false;
        break;
      case "--event-streaming":
        eventStreaming = true;
        break;
      default:
        throw new Error("Unknown option: " + value);
    }
  }

  const normalizedTargetDirectory = targetDirectory.trim();
  const normalizedOrganization = (organization ?? promptOrganization() ?? "")
    .trim();
  const normalizedDefaultBranch = defaultBranch.trim();

  if (!normalizedOrganization) {
    throw new Error(
      "GitHub organization is required; pass --organization for non-interactive use",
    );
  }

  if (normalizedTargetDirectory.length === 0) {
    throw new Error("Target directory must not be empty");
  }

  if (normalizedDefaultBranch.length === 0) {
    throw new Error("Default branch must not be empty");
  }

  return {
    targetDirectory: normalizedTargetDirectory,
    organization: normalizedOrganization,
    collectionManagement,
    defaultBranch: normalizedDefaultBranch,
    workflows,
    eventStreaming,
  };
}

function inferRepositoryName(targetDirectory: string): string {
  const normalizedTargetDirectory = targetDirectory.trim().replace(
    /[\\/]+$/,
    "",
  );
  const repositoryName = basename(normalizedTargetDirectory);

  if (
    repositoryName.length > 0 &&
    repositoryName !== "." &&
    repositoryName !== ".."
  ) {
    return repositoryName;
  }

  const cwdRepositoryName = basename(Deno.cwd());
  if (
    cwdRepositoryName.length > 0 &&
    cwdRepositoryName !== "." &&
    cwdRepositoryName !== ".."
  ) {
    return cwdRepositoryName;
  }

  return "github-config";
}

function requireValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index];

  if (value === undefined || value.startsWith("-") || value.length === 0) {
    throw new Error("Missing value for " + option);
  }

  return value;
}

async function ensureTargetDirectoryIsAvailable(path: string): Promise<void> {
  try {
    const entries = [];
    for await (const entry of Deno.readDir(path)) {
      entries.push(entry);
      if (entries.length > 0) {
        break;
      }
    }

    if (entries.length > 0) {
      throw new Error("Target directory is not empty: " + path);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.mkdir(path, { recursive: true });
      return;
    }

    throw error;
  }
}

function buildValidateWorkflow(): string {
  return `name: OctoSmith validate

on:
  pull_request:

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: Kralizek/octosmith@v0
        with:
          mode: validate
          path: .
`;
}

function buildApplyWorkflow(
  defaultBranch: string,
  eventStreaming: boolean,
): string {
  if (!eventStreaming) {
    return `name: OctoSmith apply

on:
  push:
    branches:
      - ${yamlScalar(defaultBranch)}

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: Kralizek/octosmith@v0
        with:
          mode: apply
          path: .
          github-token: \${{ secrets.OCTOSMITH_TOKEN }}
`;
  }

  return `name: OctoSmith apply

on:
  push:
    branches:
      - ${yamlScalar(defaultBranch)}

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Apply with event streaming
        shell: bash
        env:
          GITHUB_TOKEN: \${{ secrets.OCTOSMITH_TOKEN }}
        run: |
          set -euo pipefail

          events_pipe="$RUNNER_TEMP/octosmith-events"
          rm -f "$events_pipe"
          mkfifo "$events_pipe"

          hooksmith_pid=""
          cleanup() {
            rm -f "$events_pipe"
            if [[ -n "$hooksmith_pid" ]] && kill -0 "$hooksmith_pid" 2>/dev/null; then
              kill "$hooksmith_pid" 2>/dev/null || true
            fi
          }
          trap cleanup EXIT

          deno run -A jsr:@hooksmith/cli stream \
            --config ./hooksmith.config.ts \
            < "$events_pipe" &
          hooksmith_pid=$!

          set +e
          deno run -A jsr:@octosmith/cli@0 apply \
            --path . \
            --events-output "$events_pipe"
          octosmith_status=$?

          if [[ "$octosmith_status" -ne 0 ]]; then
            kill "$hooksmith_pid" 2>/dev/null || true
            wait "$hooksmith_pid" 2>/dev/null || true
            set -e
            exit "$octosmith_status"
          fi

          wait "$hooksmith_pid"
          hooksmith_status=$?
          set -e

          exit "$hooksmith_status"
`;
}

function buildHooksmithConfiguration(): string {
  return `import type { Config } from "jsr:@hooksmith/core";
import {
  all,
  eventType,
  logEvent,
  subjectKind,
} from "jsr:@hooksmith/standard";

export default {
  routes: [{
    name: "octosmith-applied-repositories",
    when: all(
      eventType("resource.applied"),
      subjectKind("github.repository"),
    ),
    listeners: [logEvent()],
  }],
} satisfies Config;
`;
}
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
function buildReadme(
  options: ScaffoldOptions,
  repositoryName: string,
): string {
  const workflowDocumentation = options.workflows
    ? `## Operating model

1. Open a pull request with configuration changes.
2. The base-controlled OctoSmith plan workflow checks out the proposed
   configuration without persisting checkout credentials and shows the expected
   changes.
3. Review and merge the pull request.
4. The OctoSmith apply workflow applies the desired state.

The plan workflow uses \`pull_request_target\` so the secret-bearing workflow
definition always comes from the base branch. It checks out the pull request
head only as configuration data; do not add steps that execute code from that
checkout while \`OCTOSMITH_TOKEN\` is available.`
    : `## Operating model

No workflows were generated because scaffolding used \`--no-workflows\`. Run
OctoSmith manually or add trusted plan/apply workflows before relying on this
repository for automation.`;

  const eventStreamingDocumentation = options.eventStreaming
    ? options.workflows
      ? `## Event streaming with Hooksmith

The apply workflow creates a local FIFO, starts \`hooksmith stream\` in the
background using \`hooksmith.config.ts\`, runs OctoSmith with
\`--events-output\` pointed at that FIFO, and waits for Hooksmith before the
workflow exits. Events therefore reach Hooksmith as each repository finishes.

The generated Hooksmith configuration handles \`resource.applied\` events for
\`github.repository\` subjects and logs each applied repository. Extend that
configuration with additional routes/listeners when you want notifications or
other reactions.`
      : `## Event streaming with Hooksmith

\`hooksmith.config.ts\` was generated because scaffolding used
\`--event-streaming\`, but no workflows were generated. To stream manually,
create a FIFO, run \`hooksmith stream\` against the generated configuration in
the background, run OctoSmith with \`--events-output\` pointing at the FIFO,
and wait for Hooksmith to finish.`
    : "";

  return `# OctoSmith control repository

This repository declares the desired GitHub state for **${options.organization}**.

## Bootstrap

After scaffolding, initialize and push this directory as the organization's
OctoSmith control repository. Keep it private if its plans may reveal private
repository configuration.

Create an \`OCTOSMITH_TOKEN\` Actions secret containing a fine-grained personal
access token with read access for resources inspected by plan and corresponding
write permissions for resources managed by apply. For renewable credentials,
replace the static secret in the generated workflows with a GitHub App token
minted at workflow runtime.

${workflowDocumentation}

The generated configuration initially scopes OctoSmith to \`${repositoryName}\`
only and uses \`${options.collectionManagement}\` collection management. Expand
the scope and templates deliberately as you adopt more repositories.

${eventStreamingDocumentation}

## Local usage

Set \`GITHUB_TOKEN\` before running either plan or apply locally:

\`\`\`sh
deno run -A jsr:@octosmith/cli plan --path .
deno run -A jsr:@octosmith/cli apply --path .
\`\`\`
`;
}
if (import.meta.main) {
  const options = parseScaffoldArguments(Deno.args);
  await writeScaffold(options);
  console.log(
    "Created OctoSmith control repository in " + options.targetDirectory,
  );
}
