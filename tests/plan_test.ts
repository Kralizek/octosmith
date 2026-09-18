import { assertEquals, assertThrows } from "@std/assert";
import {
  buildPlan,
  diffRepositorySettings,
  type CurrentRepositorySettings,
  type CurrentState,
  type DesiredState,
} from "../packages/core/mod.ts";

function currentRepositorySettings(): CurrentRepositorySettings {
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
  };
}

function currentState(): CurrentState {
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
  };
}

Deno.test("repository settings planner ignores unmanaged fields", () => {
  const changes = diffRepositorySettings(
    currentRepositorySettings(),
    {
      hasIssues: true,
    },
  );

  assertEquals(changes, undefined);
});

Deno.test("repository settings planner emits only owned drift", () => {
  const changes = diffRepositorySettings(
    currentRepositorySettings(),
    {
      description: null,
      hasIssues: false,
      hasWiki: false,
      merge: {
        allowSquashMerge: true,
        allowMergeCommit: true,
      },
      securityAndAnalysis: {
        advancedSecurity: "enabled",
        secretScanningPushProtection: "disabled",
      },
    },
  );

  assertEquals(changes, {
    description: null,
    hasIssues: false,
    merge: {
      allowMergeCommit: true,
    },
    securityAndAnalysis: {
      secretScanningPushProtection: "disabled",
    },
  });
});

Deno.test("repository settings planner treats topics as unordered", () => {
  assertEquals(
    diffRepositorySettings(
      currentRepositorySettings(),
      {
        topics: ["github", "deno"],
      },
    ),
    undefined,
  );

  assertEquals(
    diffRepositorySettings(
      currentRepositorySettings(),
      {
        topics: ["github", "octosmith"],
      },
    ),
    {
      topics: ["github", "octosmith"],
    },
  );
});

Deno.test("buildPlan emits repository settings update", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    settings: {
      hasIssues: false,
      merge: {
        allowMergeCommit: true,
      },
    },
  };

  assertEquals(buildPlan(currentState(), desired), {
    repository: "sample",
    operations: [{
      type: "update-repository-settings",
      settings: {
        hasIssues: false,
        merge: {
          allowMergeCommit: true,
        },
      },
    }],
  });
});

Deno.test("buildPlan returns an empty plan when owned state matches", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    settings: {
      hasIssues: true,
      hasWiki: false,
      topics: ["github", "deno"],
      merge: {
        allowSquashMerge: true,
      },
    },
  };

  assertEquals(buildPlan(currentState(), desired), {
    repository: "sample",
    operations: [],
  });
});

Deno.test("buildPlan rejects unsupported desired resources", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    teams: [],
  };

  assertThrows(
    () => buildPlan(currentState(), desired),
    Error,
    "Planning is not implemented yet for: teams",
  );
});

Deno.test("buildPlan rejects mismatched repositories", () => {
  const desired: DesiredState = {
    repository: "other",
    template: "code",
  };

  assertThrows(
    () => buildPlan(currentState(), desired),
    Error,
    "Cannot build a plan for different repositories",
  );
});
