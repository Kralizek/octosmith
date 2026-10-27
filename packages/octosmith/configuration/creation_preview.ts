import type { LoadedConfiguration } from "./load.ts";
import type { RepositoryCreationSpecification } from "./creation.ts";
import type { RepositoryVisibility } from "../types.ts";

/** A concise projection of configured intent, never a reconciliation delta. */
export interface RepositoryCreationResourceSummary {
  readonly category:
    | "settings"
    | "teams"
    | "custom_properties"
    | "actions"
    | "dependabot"
    | "environments"
    | "rulesets";
  readonly status: "resolved" | "not_applicable";
  readonly fields: readonly string[];
  readonly targets: readonly string[];
  readonly count?: number;
  readonly secretCount?: number;
  readonly variableCount?: number;
}

/** Bootstrap intent without file contents or invented commits. */
export interface RepositoryCreationBootstrapPreview {
  readonly defaultBranch:
    | {
      readonly status: "resolved";
      readonly source: "template";
      readonly value: string;
    }
    | {
      readonly status: "deferred";
      readonly reason: string;
      readonly precedence: readonly ["organization", "github_fallback"];
    };
  readonly files: readonly {
    readonly path: string;
    readonly presence: "present" | "absent";
  }[];
  readonly plannedFileCount: number;
}

/** Read-only creation intent suitable for text, JSON, and future execution hosts. */
export interface RepositoryCreationPreview {
  readonly kind: "repository_creation_preview";
  readonly version: 1;
  readonly organization: string;
  readonly template: string;
  readonly ready: boolean;
  readonly choices: RepositoryCreationSpecification["choices"];
  readonly diagnostics: RepositoryCreationSpecification["diagnostics"];
  readonly validation: RepositoryCreationSpecification["validation"];
  readonly identity?: {
    readonly name: string;
    readonly nameOrigin: "explicit" | "generated";
    readonly nameProvisional: boolean;
    readonly nameNotice: string;
    readonly visibility: RepositoryVisibility;
  };
  readonly requirements?: {
    readonly teams: readonly string[];
    readonly customProperties: RepositoryCreationSpecification["choices"][
      "customProperties"
    ];
  };
  readonly bootstrap?: RepositoryCreationBootstrapPreview;
  readonly resources: readonly RepositoryCreationResourceSummary[];
  readonly secretPolicy: "automatic" | "manual";
  readonly collectionManagement: "explicit" | "strict";
  readonly deferred: readonly {
    readonly code:
      | "repository_availability"
      | "classification_verification"
      | "github_reconciliation"
      | "runtime_values"
      | "secret_policy";
    readonly reason: string;
  }[];
}

/**
 * Project a preflight specification and its composed template into offline intent.
 * Use the same loaded configuration as preflight. No runtime values are resolved,
 * file contents read, or current-state/reconciliation operations calculated here.
 */
export function buildRepositoryCreationPreview(
  loaded: LoadedConfiguration,
  specification: RepositoryCreationSpecification,
): RepositoryCreationPreview {
  const base = {
    kind: "repository_creation_preview" as const,
    version: 1 as const,
    organization: loaded.configuration.organization,
    template: specification.template,
    ready: specification.ready,
    choices: specification.choices,
    diagnostics: specification.diagnostics,
    validation: specification.validation,
    secretPolicy: loaded.configuration.repositories.settings?.secrets ??
      "automatic",
    collectionManagement:
      loaded.configuration.repositories.settings?.collectionManagement ??
        "explicit",
  };
  if (!specification.ready) {
    return { ...base, resources: [], deferred: [] };
  }
  const metadata = specification.repository;
  const template = loaded.templates[specification.template];
  if (
    metadata === undefined || metadata.visibility === undefined ||
    template === undefined ||
    (specification.choices.name.status !== "explicit" &&
      specification.choices.name.status !== "generated")
  ) {
    throw new Error(
      "Ready creation specification is missing resolved metadata",
    );
  }
  const repository = template.repository;
  const generated = specification.choices.name.status === "generated";
  const files = Object.entries(repository.files ?? {})
    .map(([path, file]) => ({
      path,
      presence: file.ensure === "absent"
        ? "absent" as const
        : "present" as const,
    })).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
  const resources: RepositoryCreationResourceSummary[] = [];
  const summarize = (
    category: RepositoryCreationResourceSummary["category"],
    configuration: object | undefined,
    targets: readonly string[] = [],
    counts: Pick<
      RepositoryCreationResourceSummary,
      "count" | "secretCount" | "variableCount"
    > = {},
  ) => {
    resources.push({
      category,
      status: configuration === undefined ? "not_applicable" : "resolved",
      fields: configuration === undefined || Array.isArray(configuration)
        ? []
        : Object.keys(configuration).sort(),
      targets,
      ...counts,
    });
  };
  summarize("settings", repository.settings);
  summarize(
    "teams",
    repository.teams,
    repository.teams?.map((team) => team.name + ": " + team.permission),
    { count: repository.teams?.length ?? 0 },
  );
  summarize(
    "custom_properties",
    repository.customProperties,
    Object.keys(repository.customProperties ?? {}).sort(),
    { count: Object.keys(repository.customProperties ?? {}).length },
  );
  summarize("actions", repository.actions, [], {
    secretCount: repository.actions?.secrets?.length ?? 0,
    variableCount: repository.actions?.variables?.length ?? 0,
  });
  summarize("dependabot", repository.dependabot, [], {
    secretCount: repository.dependabot?.secrets?.length ?? 0,
  });
  summarize(
    "environments",
    repository.environments,
    repository.environments?.map((environment) => environment.name),
    {
      count: repository.environments?.length ?? 0,
      secretCount: repository.environments?.reduce(
        (count, environment) => count + (environment.secrets?.length ?? 0),
        0,
      ) ?? 0,
      variableCount: repository.environments?.reduce(
        (count, environment) => count + (environment.variables?.length ?? 0),
        0,
      ) ?? 0,
    },
  );
  summarize(
    "rulesets",
    repository.rulesets,
    repository.rulesets?.map((ruleset) => ruleset.name),
    { count: repository.rulesets?.length ?? 0 },
  );
  const hasSecrets = resources.some((resource) =>
    (resource.secretCount ?? 0) > 0
  );
  const hasVariables = resources.some((resource) =>
    (resource.variableCount ?? 0) > 0
  );
  return {
    ...base,
    identity: {
      name: metadata.name,
      nameOrigin: generated ? "generated" : "explicit",
      nameProvisional: generated,
      nameNotice: generated
        ? "Generated preview name is not reserved; execution may generate a different name unless --name is supplied."
        : "Explicit name; availability must still be checked during execution.",
      visibility: metadata.visibility,
    },
    requirements: {
      teams: specification.choices.teams,
      customProperties: specification.choices.customProperties,
    },
    bootstrap: {
      defaultBranch: repository.settings?.defaultBranch === undefined
        ? {
          status: "deferred",
          reason:
            "Resolve the organization's default repository branch during execution, then use GitHub's documented fallback if unavailable.",
          precedence: ["organization", "github_fallback"],
        }
        : {
          status: "resolved",
          source: "template",
          value: repository.settings.defaultBranch,
        },
      files,
      plannedFileCount:
        files.filter((file) => file.presence === "present").length,
    },
    resources,
    deferred: [
      {
        code: "repository_availability",
        reason: "Repository name availability requires GitHub access.",
      },
      {
        code: "classification_verification",
        reason:
          "Verify selector assignments and classification against the created repository.",
      },
      {
        code: "github_reconciliation",
        reason:
          "Exact API changes require organization/repository state after creation; no deltas, commits, or pull requests are planned.",
      },
      ...(hasVariables || (hasSecrets && base.secretPolicy === "automatic")
        ? [{
          code: "runtime_values" as const,
          reason:
            "Resolve runtime-backed values and secret availability during execution; values are omitted from this preview.",
        }]
        : []),
      ...(hasSecrets && base.secretPolicy === "manual"
        ? [{
          code: "secret_policy" as const,
          reason:
            "Configured secrets are excluded by the manual secret policy unless execution explicitly opts in.",
        }]
        : []),
    ],
  };
}
