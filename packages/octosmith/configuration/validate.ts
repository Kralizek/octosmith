import {
  buildPlan,
  type CurrentState,
  loadConfigurationDirectory,
  type RepositoryMetadata,
  type RepositoryTemplate,
  resolveDesiredState,
} from "../mod.ts";

/**
 * Validate a configuration directory without consulting GitHub.
 *
 * This loads the configuration and templates, resolves each template against
 * synthetic repository metadata that satisfies its selector, reads referenced
 * local files, and exercises static planner invariants against an empty current
 * state.
 */
export async function validateConfigurationDirectory(
  root: string,
): Promise<void> {
  const loaded = await loadConfigurationDirectory(root);

  for (const [name, template] of Object.entries(loaded.templates)) {
    const repository = repositoryForTemplate(name, template);
    const desired = await resolveDesiredState(
      loaded,
      repository,
      (value) => "validation:" + value,
    );

    buildPlan(emptyCurrentState(repository.name), desired);
  }

  for (const name of loaded.configuration.repositories.scope.names ?? []) {
    if (name.includes("*") || name.includes("?")) {
      continue;
    }

    const repository: RepositoryMetadata = {
      name,
      teams: [],
      properties: {},
    };
    const desired = await resolveDesiredState(
      loaded,
      repository,
      (value) => "validation:" + value,
    );

    buildPlan(emptyCurrentState(repository.name), desired);
  }
}

function repositoryForTemplate(
  templateName: string,
  template: RepositoryTemplate,
): RepositoryMetadata {
  const selector = template.match;
  const name = selector.names?.[0]
    ? materializeName(selector.names[0], templateName)
    : "validation-" + templateName;
  const visibility = Array.isArray(selector.visibility)
    ? selector.visibility[0]
    : selector.visibility;

  return {
    name,
    teams: selector.teams ?? [],
    ...(visibility !== undefined && { visibility }),
    properties: selector.properties ?? {},
  };
}

function materializeName(pattern: string, fallback: string): string {
  const value = pattern
    .replaceAll("*", "validation")
    .replaceAll("?", "x");

  return value.length > 0 ? value : "validation-" + fallback;
}

function emptyCurrentState(repository: string): CurrentState {
  return {
    repository,
    settings: {
      name: repository,
      description: null,
      website: null,
      topics: [],
      visibility: "private",
      hasIssues: false,
      hasProjects: false,
      hasWiki: false,
      hasDiscussions: false,
      hasPullRequests: true,
      pullRequestCreationPolicy: "all",
      isTemplate: false,
      defaultBranch: "main",
      merge: {
        allowSquashMerge: true,
        allowMergeCommit: true,
        allowRebaseMerge: true,
        allowAutoMerge: false,
        allowUpdateBranch: false,
        deleteBranchOnMerge: false,
        squashMergeCommitTitle: "pull-request-title",
        squashMergeCommitMessage: "pull-request-body",
        mergeCommitTitle: "pull-request-title",
        mergeCommitMessage: "pull-request-title",
      },
      archived: false,
      allowForking: false,
      webCommitSignoffRequired: false,
      securityAndAnalysis: {},
    },
    customProperties: {},
    actions: {
      enabled: true,
      allowedActions: "all",
      shaPinningRequired: false,
      oidc: {
        subjectClaimTemplate: { source: "default" },
        immutableSubject: false,
      },
      secrets: [],
      variables: [],
    },
    dependabot: { secrets: [] },
    teams: [],
    rulesets: [],
    environments: [],
    files: [],
  };
}
