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

export function currentState(
  overrides: Partial<CurrentState> = {},
): CurrentState {
  return {
    repository: "sample",
    settings: currentRepositorySettings(),
    customProperties: {},
    actions: {
      enabled: true,
      allowedActions: "all",
      shaPinningRequired: false,
      oidc: {
        subjectClaimTemplate: { source: "default" },
        immutableSubject: false,
      },
    },
    teams: [],
    secrets: [],
    variables: [],
    rulesets: [],
    environments: [],
    files: [],
    ...overrides,
  };
}
