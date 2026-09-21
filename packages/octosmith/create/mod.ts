import { basename, dirname, join } from "@std/path";
import type { CollectionManagementMode } from "../types.ts";
import configurationTemplate from "./templates/octosmith.yml" with {
  type: "text",
};
import repositoryTemplate from "./templates/default.yml" with { type: "text" };
import gitignoreTemplate from "./templates/gitignore" with { type: "text" };
import hooksmithTemplate from "./templates/hooksmith.config.ts" with {
  type: "text",
};
import validateWorkflowTemplate from "./templates/workflows/validate.yml" with {
  type: "text",
};
import applyWorkflowTemplate from "./templates/workflows/apply.yml" with {
  type: "text",
};
import streamingApplyWorkflowTemplate from "./templates/workflows/apply-streaming.yml" with {
  type: "text",
};
import readmeTemplate from "./templates/README.md" with { type: "text" };
import workflowsReadmeTemplate from "./templates/readme/workflows.md" with {
  type: "text",
};
import noWorkflowsReadmeTemplate from "./templates/readme/no-workflows.md" with {
  type: "text",
};
import eventStreamingReadmeTemplate from "./templates/readme/event-streaming.md" with {
  type: "text",
};
import manualEventStreamingReadmeTemplate from "./templates/readme/event-streaming-manual.md" with {
  type: "text",
};

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
  const common = {
    "@@ORGANIZATION@@": yamlScalar(options.organization),
    "@@REPOSITORY_NAME@@": yamlScalar(repositoryName),
    "@@COLLECTION_MANAGEMENT@@": yamlScalar(options.collectionManagement),
  };

  const files: ScaffoldFile[] = [
    {
      path: "octosmith.yml",
      content: renderTemplate(configurationTemplate, common),
    },
    {
      path: "templates/default.yml",
      content: renderTemplate(repositoryTemplate, common),
    },
    {
      path: ".gitignore",
      content: gitignoreTemplate,
    },
    {
      path: "README.md",
      content: renderTemplate(readmeTemplate, {
        "@@ORGANIZATION@@": options.organization,
        "@@REPOSITORY_NAME_RAW@@": repositoryName,
        "@@COLLECTION_MANAGEMENT_RAW@@": options.collectionManagement,
        "@@WORKFLOW_DOCUMENTATION@@": (
          options.workflows
            ? workflowsReadmeTemplate
            : noWorkflowsReadmeTemplate
        ).trim(),
        "@@EVENT_STREAMING_DOCUMENTATION@@": options.eventStreaming
          ? (
            options.workflows
              ? eventStreamingReadmeTemplate
              : manualEventStreamingReadmeTemplate
          ).trim()
          : "",
      }),
    },
  ];

  if (options.eventStreaming) {
    files.push({
      path: "hooksmith.config.ts",
      content: hooksmithTemplate,
    });
  }

  if (options.workflows) {
    files.push(
      {
        path: ".github/workflows/octosmith-validate.yml",
        content: validateWorkflowTemplate,
      },
      {
        path: ".github/workflows/octosmith-apply.yml",
        content: renderTemplate(
          options.eventStreaming
            ? streamingApplyWorkflowTemplate
            : applyWorkflowTemplate,
          { "@@DEFAULT_BRANCH@@": yamlScalar(options.defaultBranch) },
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

function renderTemplate(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let rendered = template;

  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }

  const unresolved = rendered.match(/@@[A-Z0-9_]+@@/g);
  if (unresolved) {
    throw new Error(
      "Unresolved scaffold template placeholders: " +
        [...new Set(unresolved)].join(", "),
    );
  }

  return rendered;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
if (import.meta.main) {
  const options = parseScaffoldArguments(Deno.args);
  await writeScaffold(options);
  console.log(
    "Created OctoSmith control repository in " + options.targetDirectory,
  );
}
