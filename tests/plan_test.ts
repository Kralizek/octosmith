import { assertEquals, assertThrows } from "@std/assert";
import {
  buildPlan,
  type CurrentRepositorySettings,
  type CurrentState,
  type DesiredState,
  diffRepositorySettings,
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

function currentState(overrides: Partial<CurrentState> = {}): CurrentState {
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

Deno.test("buildPlan reconciles all desired resource families", () => {
  const current = currentState({
    customProperties: {
      "repository-type": "code",
      regions: ["eu", "us"],
    },
    actions: {
      enabled: true,
      allowedActions: "all",
      shaPinningRequired: false,
      selectedActions: {
        githubOwnedAllowed: true,
        verifiedAllowed: false,
        patternsAllowed: ["actions/*"],
      },
      oidc: {
        subjectClaimTemplate: { source: "default" },
        immutableSubject: false,
      },
    },
    teams: [{
      team: "platform",
      permission: { kind: "built-in", name: "pull" },
    }],
    secrets: ["OLD_SECRET", "TOKEN"],
    variables: [
      { name: "UNCHANGED", value: "same" },
      { name: "REGION", value: "west" },
    ],
    rulesets: [{
      id: 10,
      name: "protect",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [
        { type: "deletion" },
        { type: "update", updateAllowsFetchAndMerge: false },
      ],
    }],
    environments: [{
      name: "production",
      secrets: ["DEPLOY_TOKEN"],
      variables: [{ name: "REGION", value: "west" }],
    }],
    files: [
      { path: "README.md", content: "old", sha: "readme-sha" },
      { path: "KEEP.md", content: "customized", sha: "keep-sha" },
      { path: "REMOVE.md", content: "remove", sha: "remove-sha" },
    ],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    settings: {
      hasIssues: false,
    },
    customProperties: {
      "repository-type": "code",
      regions: ["us", "eu"],
      tier: "critical",
    },
    actions: {
      enabled: true,
      allowedActions: "selected",
      selectedActions: {
        githubOwnedAllowed: true,
        verifiedAllowed: true,
        patternsAllowed: ["actions/*"],
      },
      oidc: {
        subjectClaimTemplate: {
          source: "custom",
          claims: ["repo"],
        },
        immutableSubject: true,
      },
    },
    teams: [
      {
        team: "platform",
        permission: { kind: "built-in", name: "maintain" },
      },
      {
        team: "release",
        permission: { kind: "custom", name: "release-manager" },
      },
    ],
    secrets: ["TOKEN", "NEW_SECRET"],
    variables: [
      { name: "UNCHANGED", value: "same" },
      { name: "REGION", value: "north" },
      { name: "NEW_VARIABLE", value: "value" },
    ],
    rulesets: [{
      name: "protect",
      enforcement: "evaluate",
      conditions: {
        refName: {
          exclude: ["refs/heads/generated"],
        },
      },
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: true,
      }],
    }],
    environments: [{
      name: "production",
      secrets: ["DEPLOY_TOKEN"],
      variables: [{ name: "REGION", value: "north" }],
    }, {
      name: "staging",
      secrets: [],
      variables: [],
    }],
    files: [
      { path: "README.md", ensure: "exact", content: "new" },
      { path: "KEEP.md", ensure: "exists", content: "seed" },
      { path: "CREATE.md", ensure: "exists", content: "created" },
      { path: "REMOVE.md", ensure: "absent" },
    ],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [
      {
        type: "update-repository-settings",
        settings: { hasIssues: false },
      },
      {
        type: "set-custom-property",
        name: "tier",
        value: "critical",
      },
      {
        type: "update-actions-settings",
        settings: {
          allowedActions: "selected",
          selectedActions: {
            verifiedAllowed: true,
          },
        },
      },
      {
        type: "update-actions-oidc",
        settings: {
          subjectClaimTemplate: {
            source: "custom",
            claims: ["repo"],
          },
          immutableSubject: true,
        },
      },
      {
        type: "set-team-permission",
        permission: {
          team: "platform",
          permission: { kind: "built-in", name: "maintain" },
        },
      },
      {
        type: "set-team-permission",
        permission: {
          team: "release",
          permission: { kind: "custom", name: "release-manager" },
        },
      },
      { type: "set-repository-secret", secret: "TOKEN" },
      { type: "set-repository-secret", secret: "NEW_SECRET" },
      {
        type: "set-repository-variable",
        variable: { name: "REGION", value: "north" },
      },
      {
        type: "set-repository-variable",
        variable: { name: "NEW_VARIABLE", value: "value" },
      },
      {
        type: "update-ruleset",
        id: 10,
        changes: {
          name: "protect",
          enforcement: "evaluate",
          conditions: {
            refName: {
              include: ["~DEFAULT_BRANCH"],
              exclude: ["refs/heads/generated"],
            },
          },
          rules: [
            { type: "deletion" },
            { type: "update", updateAllowsFetchAndMerge: true },
          ],
        },
      },
      {
        type: "update-environment",
        environment: {
          name: "production",
          secrets: ["DEPLOY_TOKEN"],
          variables: [{ name: "REGION", value: "north" }],
        },
      },
      {
        type: "create-environment",
        environment: {
          name: "staging",
          secrets: [],
          variables: [],
        },
      },
      {
        type: "update-file",
        sha: "readme-sha",
        file: { path: "README.md", ensure: "exact", content: "new" },
      },
      {
        type: "create-file",
        file: { path: "CREATE.md", ensure: "exists", content: "created" },
      },
      {
        type: "delete-file",
        path: "REMOVE.md",
        sha: "remove-sha",
      },
    ],
  });
});

Deno.test("explicit empty collections do not remove repository values by default", () => {
  const current = currentState({
    teams: [
      { team: "a", permission: { kind: "built-in", name: "pull" } },
      { team: "b", permission: { kind: "built-in", name: "push" } },
    ],
    secrets: ["A", "B"],
    variables: [
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ],
    rulesets: [{
      id: 1,
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [],
    }],
    environments: [{
      name: "production",
      secrets: [],
      variables: [],
    }],
    files: [{
      path: "README.md",
      content: "content",
      sha: "sha",
    }],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    customProperties: {},
    teams: [],
    secrets: [],
    variables: [],
    rulesets: [],
    environments: [],
    files: [],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });
});

Deno.test("declared repository secrets are always set because values are opaque", () => {
  const current = currentState({
    secrets: ["TOKEN"],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      secrets: ["TOKEN"],
    }),
    {
      repository: "sample",
      operations: [{ type: "set-repository-secret", secret: "TOKEN" }],
    },
  );
});

Deno.test("ruleset creation requires materializable identity and conditions", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{ name: "protect" }],
      }),
    Error,
    "requires target",
  );

  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "protect",
          target: "branch",
          enforcement: "active",
        }],
      }),
    Error,
    "requires conditions.refName",
  );

  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "push-policy",
        target: "push",
        enforcement: "active",
        rules: [],
      }],
    }),
    {
      repository: "sample",
      operations: [{
        type: "create-ruleset",
        ruleset: {
          name: "push-policy",
          target: "push",
          enforcement: "active",
          bypassActors: [],
          rules: [],
        },
      }],
    },
  );
});

Deno.test("files require explicit absent intent for deletion", () => {
  const current = currentState({
    files: [{
      path: "README.md",
      content: "custom",
      sha: "sha",
    }],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      files: [],
    }),
    {
      repository: "sample",
      operations: [],
    },
  );

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      files: [{
        path: "README.md",
        ensure: "exists",
        content: "seed",
      }],
    }),
    {
      repository: "sample",
      operations: [],
    },
  );
});

Deno.test("strict mode removes undeclared repository secrets and variables", () => {
  const current = currentState({
    secrets: ["KEEP", "REMOVE"],
    variables: [
      { name: "KEEP", value: "same" },
      { name: "REMOVE", value: "old" },
    ],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    secrets: ["KEEP", "NEW"],
    variables: [
      { name: "KEEP", value: "same" },
      { name: "NEW", value: "new" },
    ],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [
      { type: "set-repository-secret", secret: "KEEP" },
      { type: "set-repository-secret", secret: "NEW" },
      {
        type: "set-repository-variable",
        variable: { name: "NEW", value: "new" },
      },
    ],
  });

  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "remove-repository-secret", secret: "REMOVE" },
      { type: "set-repository-secret", secret: "KEEP" },
      { type: "set-repository-secret", secret: "NEW" },
      { type: "remove-repository-variable", name: "REMOVE" },
      {
        type: "set-repository-variable",
        variable: { name: "NEW", value: "new" },
      },
    ],
  });
});

Deno.test("strict mode allows explicit empty repository value collections to clear them", () => {
  const current = currentState({
    secrets: ["A", "B"],
    variables: [
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    secrets: [],
    variables: [],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });

  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "remove-repository-secret", secret: "A" },
      { type: "remove-repository-secret", secret: "B" },
      { type: "remove-repository-variable", name: "A" },
      { type: "remove-repository-variable", name: "B" },
    ],
  });
});

Deno.test("strict collection mode prunes undeclared named resources", () => {
  const current = currentState({
    customProperties: {
      keep: "same",
      remove: "value",
    },
    teams: [
      { team: "keep", permission: { kind: "built-in", name: "pull" } },
      { team: "remove", permission: { kind: "built-in", name: "push" } },
    ],
    rulesets: [
      {
        id: 1,
        name: "keep",
        target: "push",
        enforcement: "active",
        bypassActors: [],
        rules: [],
      },
      {
        id: 2,
        name: "remove",
        target: "push",
        enforcement: "active",
        bypassActors: [],
        rules: [],
      },
    ],
    environments: [
      { name: "keep", secrets: [], variables: [] },
      { name: "remove", secrets: [], variables: [] },
    ],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    customProperties: { keep: "same" },
    teams: [
      { team: "keep", permission: { kind: "built-in", name: "pull" } },
    ],
    rulesets: [{
      name: "keep",
      target: "push",
      enforcement: "active",
      rules: [],
    }],
    environments: [
      { name: "keep", secrets: [], variables: [] },
    ],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });

  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "set-custom-property", name: "remove", value: null },
      { type: "remove-team-permission", team: "remove" },
      { type: "delete-ruleset", id: 2, name: "remove" },
      { type: "delete-environment", name: "remove" },
    ],
  });
});

Deno.test("strict collection mode prunes undeclared rules within an owned ruleset", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [
        { type: "deletion" },
        { type: "update", updateAllowsFetchAndMerge: false },
      ],
    }],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    rulesets: [{
      name: "protect",
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: true,
      }],
    }],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [{
      type: "update-ruleset",
      id: 1,
      changes: {
        name: "protect",
        rules: [
          { type: "deletion" },
          { type: "update", updateAllowsFetchAndMerge: true },
        ],
      },
    }],
  });

  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [{
      type: "update-ruleset",
      id: 1,
      changes: {
        name: "protect",
        rules: [
          { type: "update", updateAllowsFetchAndMerge: true },
        ],
      },
    }],
  });
});

Deno.test("strict collection mode does not infer file deletion", () => {
  const current = currentState({
    files: [{
      path: "README.md",
      content: "content",
      sha: "sha",
    }],
  });

  assertEquals(
    buildPlan(
      current,
      {
        repository: "sample",
        template: "code",
        files: [],
      },
      { collections: "strict" },
    ),
    {
      repository: "sample",
      operations: [],
    },
  );
});

Deno.test("empty named collections prune only in strict mode", () => {
  const current = currentState({
    teams: [
      { team: "a", permission: { kind: "built-in", name: "pull" } },
    ],
    rulesets: [{
      id: 1,
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [],
    }],
    environments: [{
      name: "production",
      secrets: [],
      variables: [],
    }],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    teams: [],
    rulesets: [],
    environments: [],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });

  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "remove-team-permission", team: "a" },
      { type: "delete-ruleset", id: 1, name: "protect" },
      { type: "delete-environment", name: "production" },
    ],
  });
});

Deno.test("empty rules list is non-destructive in sparse mode", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [
        { type: "file-path-restriction", restrictedFilePaths: ["secrets/**"] },
      ],
    }],
  });

  const desired: DesiredState = {
    repository: "sample",
    template: "code",
    rulesets: [{
      name: "protect",
      rules: [],
    }],
  };

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [],
  });

  assertEquals(buildPlan(current, desired, { collections: "strict" }), {
    repository: "sample",
    operations: [{
      type: "update-ruleset",
      id: 1,
      changes: {
        name: "protect",
        rules: [],
      },
    }],
  });
});
