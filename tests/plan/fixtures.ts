import type {
  CurrentRepositorySettings,
  CurrentState,
} from "../../packages/core/mod.ts";

export function currentRepositorySettings(
  overrides: Partial<CurrentRepositorySettings> = {},
): CurrentRepositorySettings {
  return {
    name: "sample",
    description: "Sample repository",
    website: null,
    topics: ["deno", "github"],
    visibility: "private",
    hasIssues: true,
    hasProjects: false,
    hasWiki: false,
    hasDiscussions: false,
    hasPullRequests: true,
    pullRequestCreationPolicy: "all",
    isTemplate: false,
    defaultBranch: "main",
    merge: {
      allowSquashMerge: true,
      allowMergeCommit: false,
      allowRebaseMerge: false,
      allowAutoMerge: false,
      allowUpdateBranch: true,
      deleteBranchOnMerge: true,
      squashMergeCommitTitle: "pull-request-title",
      squashMergeCommitMessage: "pull-request-body",
      mergeCommitTitle: "pull-request-title",
      mergeCommitMessage: "pull-request-body",
    },
    archived: false,
    allowForking: false,
    webCommitSignoffRequired: true,
    securityAndAnalysis: {
      advancedSecurity: "enabled",
      secretScanning: "enabled",
      secretScanningPushProtection: "enabled",
    },
    ...overrides,
  };
}

type CurrentStateOverrides =
  & Omit<Partial<CurrentState>, "actions" | "dependabot">
  & {
    readonly actions?: Partial<CurrentState["actions"]>;
    readonly dependabot?: Partial<CurrentState["dependabot"]>;
  };

export function currentState(
  overrides: CurrentStateOverrides = {},
): CurrentState {
  const actions: CurrentState["actions"] = {
    enabled: true,
    allowedActions: "all",
    shaPinningRequired: false,
    oidc: {
      subjectClaimTemplate: { source: "default" },
      immutableSubject: false,
    },
    secrets: [],
    variables: [],
    ...overrides.actions,
  };
  const dependabot: CurrentState["dependabot"] = {
    secrets: [],
    ...overrides.dependabot,
  };

  return {
    repository: "sample",
    settings: currentRepositorySettings(),
    customProperties: {},
    actions,
    dependabot,
    teams: [],
    rulesets: [],
    environments: [],
    files: [],
    ...overrides,
  };
}
