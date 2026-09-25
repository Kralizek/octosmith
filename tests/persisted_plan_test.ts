import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  buildApplyEvaluations,
  buildPlan,
  createPersistedPlanArtifact,
  type DesiredState,
  hashCanonical,
  hashEffectiveTemplate,
  type LoadedConfiguration,
  parsePersistedPlanArtifact,
  persistedOperationContract,
  projectOwnedCurrentState,
} from "../packages/octosmith/mod.ts";
import { currentState } from "./plan/fixtures.ts";
import { applyPersistedPlan } from "../packages/cli/persisted.ts";

Deno.test("canonical hashing is independent of object key order", async () => {
  assertEquals(
    await hashCanonical({ b: 2, nested: { z: true, a: "x" }, a: 1 }),
    await hashCanonical({ a: 1, nested: { a: "x", z: true }, b: 2 }),
  );

  assertNotEquals(
    await hashCanonical({ values: ["a", "b"] }),
    await hashCanonical({ values: ["b", "a"] }),
  );
});

Deno.test("replay contract captures sparse apply-time live state", () => {
  const current = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: {
        refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      },
      rules: [{ type: "required-linear-history" }],
    }],
    environments: [{
      name: "production",
      secrets: ["TOKEN", "OTHER"],
      variables: [{ name: "A", value: "1" }, { name: "B", value: "2" }],
    }],
  });

  const contract = persistedOperationContract(current, [
    {
      type: "update-actions-settings",
      settings: { enabled: false },
    },
    {
      type: "update-actions-oidc",
      settings: { immutableSubject: true },
    },
    {
      type: "update-ruleset",
      id: 7,
      changes: { name: "main", enforcement: "evaluate" },
    },
    {
      type: "update-environment",
      environment: { name: "production", variables: [] },
      collections: "explicit",
    },
  ]);

  assertEquals(contract.state.actions, {
    settings: {
      allowedActions: current.actions.allowedActions,
      shaPinningRequired: current.actions.shaPinningRequired,
    },
    oidc: {
      subjectClaimTemplate: current.actions.oidc.subjectClaimTemplate,
    },
  });
  assertEquals(contract.state.rulesets, [{
    operation: "update",
    id: 7,
    exists: true,
    target: "branch",
    bypassActors: [],
    conditions: {
      refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    },
    rules: [{ type: "required-linear-history" }],
  }]);
  assertEquals(contract.state.environments, [{
    operation: "update",
    name: "production",
    exists: true,
    variables: ["A", "B"],
  }]);
});

Deno.test("replay contract tracks ruleset fields copied into stored updates", () => {
  const current = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: ["refs/heads/legacy"],
        },
      },
      rules: [
        { type: "required-linear-history" },
        {
          type: "required-status-checks",
          doNotEnforceOnCreate: false,
          checks: [{ context: "build" }],
          strict: false,
        },
      ],
    }],
  });
  const plan = buildPlan(current, {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      conditions: {
        refName: { include: ["refs/heads/main"] },
      },
      rules: [{
        type: "required-status-checks",
        strict: true,
      }],
    }],
  });
  const update = plan.operations[0];
  if (update?.type !== "update-ruleset") {
    throw new Error("Expected update-ruleset");
  }

  const dependency = persistedOperationContract(current, [update]).state
    .rulesets as readonly Record<string, unknown>[];

  assertEquals(dependency[0].conditions, {
    refName: { exclude: ["refs/heads/legacy"] },
  });
  assertEquals(dependency[0].rules, [{
    type: "required-linear-history",
  }, {
    type: "required-status-checks",
    doNotEnforceOnCreate: false,
    checks: [{ context: "build" }],
    strict: false,
  }]);
});

Deno.test("replacement rule preconditions cover fields outside the saved shape", async () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      rules: [{ type: "commit-message-pattern", pattern: "reviewed" }],
    }],
  };
  const current = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: { refName: { include: [], exclude: [] } },
      rules: [{
        type: "commit-message-pattern",
        operator: "contains",
        pattern: "original",
      }],
    }],
  });
  const operations = buildPlan(current, desired).operations;
  const before = await hashCanonical(
    projectOwnedCurrentState(current, desired, operations),
  );

  for (
    const added of [
      { negate: true },
      { futureField: { nested: ["new"] } },
    ]
  ) {
    const changed = structuredClone(current);
    Object.assign(changed.rulesets[0].rules[0], added);
    assertNotEquals(
      before,
      await hashCanonical(
        projectOwnedCurrentState(changed, desired, operations),
      ),
    );
  }
});

Deno.test("replay contract tracks newly populated fields overwritten by materialized rules", () => {
  const baseRule = {
    type: "pull-request" as const,
    allowedMergeMethods: ["squash" as const],
    dismissStaleReviewsOnPush: false,
    dismissalRestriction: { enabled: false, allowedActors: [] },
    requireCodeOwnerReview: false,
    requiredApprovingReviewCount: 0,
    requiredReviewThreadResolution: false,
    requiredReviewers: [],
  };
  const left = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: { refName: { include: [], exclude: [] } },
      rules: [baseRule as never],
    }],
  });
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      rules: [{
        type: "pull-request",
        allowedMergeMethods: ["merge"],
      }],
    }],
  };
  const operations = buildPlan(left, desired).operations;
  const right = currentState({
    rulesets: [{
      ...left.rulesets[0],
      rules: [{ ...baseRule, requireLastPushApproval: true } as never],
    }],
  });

  assertNotEquals(
    projectOwnedCurrentState(left, desired, operations),
    projectOwnedCurrentState(right, desired, operations),
  );
});

Deno.test("strict rule removal ignores unrelated rule contents", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    collections: "strict",
    rulesets: [{ name: "main", rules: [] }],
  };
  const left = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: { refName: { include: [], exclude: [] } },
      rules: [{
        type: "required-status-checks",
        doNotEnforceOnCreate: false,
        checks: [],
        strict: false,
      }],
    }],
  });
  const right = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: { refName: { include: [], exclude: [] } },
      rules: [{
        type: "required-status-checks",
        doNotEnforceOnCreate: false,
        checks: [],
        strict: true,
      }],
    }],
  });
  const operations = buildPlan(left, desired).operations;

  assertEquals(
    projectOwnedCurrentState(left, desired, operations),
    projectOwnedCurrentState(right, desired, operations),
  );
});

Deno.test("replay contract tracks create-time absence and file branch dependencies", () => {
  const current = currentState();
  const contract = persistedOperationContract(current, [
    {
      type: "create-ruleset",
      ruleset: {
        name: "new",
        target: "branch",
        enforcement: "active",
        bypassActors: [],
        conditions: { refName: { include: [], exclude: [] } },
        rules: [],
      },
    },
    {
      type: "create-environment",
      environment: { name: "production", secrets: [], variables: [] },
    },
    {
      type: "create-file",
      file: { path: "managed.txt", ensure: "exact", content: "x" },
    },
  ]);

  assertEquals(contract.state.rulesets, [{
    operation: "create",
    name: "new",
    exists: false,
  }]);
  assertEquals(contract.state.environments, [{
    operation: "create",
    name: "production",
    exists: false,
  }]);
  assertEquals(contract.state.files, [{
    operation: "create",
    path: "managed.txt",
    exists: false,
  }]);
  assertEquals(contract.state.defaultBranch, current.settings.defaultBranch);
});

Deno.test("owned state ignores unowned repository settings", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    settings: { hasIssues: false },
  };
  const original = currentState();
  const unrelated = currentState({
    settings: {
      ...original.settings,
      description: "changed but unowned",
    },
  });
  const owned = currentState({
    settings: {
      ...original.settings,
      hasIssues: false,
    },
  });

  assertEquals(
    projectOwnedCurrentState(original, desired),
    projectOwnedCurrentState(unrelated, desired),
  );
  assertNotEquals(
    projectOwnedCurrentState(original, desired),
    projectOwnedCurrentState(owned, desired),
  );
});

Deno.test("strict collections track membership but not unowned member details", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    collections: "strict",
    teams: [{
      team: "platform",
      permission: { kind: "built-in", name: "push" },
    }],
  };
  const left = currentState({
    teams: [
      { team: "platform", permission: { kind: "built-in", name: "pull" } },
      { team: "legacy", permission: { kind: "built-in", name: "pull" } },
    ],
  });
  const right = currentState({
    teams: [
      { team: "platform", permission: { kind: "built-in", name: "pull" } },
      { team: "legacy", permission: { kind: "built-in", name: "admin" } },
    ],
  });

  assertEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(right, desired),
  );
});

Deno.test("owned state follows planner equivalence for unordered settings", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    settings: { topics: ["github", "deno"] },
  };
  const left = currentState({
    settings: {
      ...currentState().settings,
      topics: ["deno", "github"],
    },
  });
  const right = currentState({
    settings: {
      ...currentState().settings,
      topics: ["github", "deno"],
    },
  });

  assertEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(right, desired),
  );
});

Deno.test("file concurrency sha participates only when a stored operation depends on it", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    files: [{ path: "managed.txt", ensure: "exact", content: "target" }],
  };
  const left = currentState({
    files: [{ path: "managed.txt", content: "target", sha: "sha-1" }],
  });
  const right = currentState({
    files: [{ path: "managed.txt", content: "target", sha: "sha-2" }],
  });

  assertEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(right, desired),
  );

  const operation = {
    type: "update-file" as const,
    sha: "sha-1",
    file: { path: "managed.txt", ensure: "exact" as const, content: "target" },
  };

  assertNotEquals(
    projectOwnedCurrentState(left, desired, [operation]),
    projectOwnedCurrentState(right, desired, [operation]),
  );
});

Deno.test("explicit custom-property preconditions ignore unrelated properties", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    customProperties: { owner: "platform" },
  };
  const left = currentState({
    customProperties: {
      owner: "platform",
      unrelated: "left",
    },
  });
  const right = currentState({
    customProperties: {
      owner: "platform",
      unrelated: "right",
    },
  });

  assertEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(right, desired),
  );
});

Deno.test("strict custom-property preconditions track unowned presence, not value", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    collections: "strict",
    customProperties: { owner: "platform" },
  };
  const left = currentState({
    customProperties: {
      owner: "platform",
      unrelated: "left",
    },
  });
  const right = currentState({
    customProperties: {
      owner: "platform",
      unrelated: "right",
    },
  });
  const removed = currentState({
    customProperties: {
      owner: "platform",
      unrelated: null,
    },
  });

  assertEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(right, desired),
  );
  assertNotEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(removed, desired),
  );
});

Deno.test("strict custom-property preconditions track prototype-like unowned names", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    collections: "strict",
    customProperties: {},
  };
  const before = currentState({ customProperties: {} });
  const added = currentState({ customProperties: { toString: "platform" } });

  assertNotEquals(
    projectOwnedCurrentState(before, desired),
    projectOwnedCurrentState(added, desired),
  );
  assertEquals(projectOwnedCurrentState(added, desired).customProperties, {
    owned: {},
    strictUnowned: ["toString"],
  });
  assertEquals(
    projectOwnedCurrentState(added, {
      ...desired,
      customProperties: { toString: "platform" },
    }).customProperties,
    {
      owned: { toString: { present: true, value: "platform" } },
      strictUnowned: [],
    },
  );
});

Deno.test("ruleset preconditions include fields materialized into stored updates", () => {
  const leftRuleset = {
    id: 7,
    name: "main",
    target: "branch" as const,
    enforcement: "active" as const,
    bypassActors: [],
    conditions: {
      refName: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
    },
    rules: [
      {
        type: "update" as const,
        updateAllowsFetchAndMerge: false,
      },
      {
        type: "required-status-checks" as const,
        doNotEnforceOnCreate: false,
        checks: [{ context: "build" }],
        strict: false,
      },
    ],
  };
  const rightRuleset = {
    ...leftRuleset,
    rules: [
      leftRuleset.rules[0],
      {
        ...leftRuleset.rules[1],
        strict: true,
      },
    ],
  };
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: true,
      }],
    }],
  };
  const left = currentState({ rulesets: [leftRuleset] });
  const right = currentState({ rulesets: [rightRuleset] });
  const plan = buildPlan(left, desired);

  assertEquals(plan.operations[0]?.type, "update-ruleset");
  assertNotEquals(
    projectOwnedCurrentState(left, desired, plan.operations),
    projectOwnedCurrentState(right, desired, plan.operations),
  );
});

Deno.test("target-only ruleset updates depend on current rules", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      target: "tag",
    }],
  };
  const baseRuleset = {
    id: 7,
    name: "main",
    target: "branch" as const,
    enforcement: "active" as const,
    bypassActors: [],
    conditions: {
      refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    },
    rules: [{
      type: "required-linear-history" as const,
    }],
  };
  const changedRuleset = {
    ...baseRuleset,
    rules: [
      ...baseRuleset.rules,
      {
        type: "deletion" as const,
      },
    ],
  };
  const left = currentState({ rulesets: [baseRuleset] });
  const right = currentState({ rulesets: [changedRuleset] });
  const plan = buildPlan(left, desired);

  assertEquals(plan.operations[0]?.type, "update-ruleset");
  assertNotEquals(
    projectOwnedCurrentState(left, desired, plan.operations),
    projectOwnedCurrentState(right, desired, plan.operations),
  );
});

Deno.test("target-dependent ruleset updates persist the effective target", () => {
  const current = currentState({
    rulesets: [{
      id: 7,
      name: "main",
      target: "branch",
      enforcement: "active",
      bypassActors: [],
      conditions: {
        refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
      },
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: false,
      }],
    }],
  });
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: true,
      }],
    }],
  };
  const plan = buildPlan(current, desired);
  const operation = plan.operations[0];

  assertEquals(operation?.type, "update-ruleset");
  if (operation?.type === "update-ruleset") {
    assertEquals(operation.changes.target, "branch");
  }
});

Deno.test("explicit Actions and Dependabot secrets ignore unrelated current names", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    actions: {
      secrets: [{ name: "TOKEN", source: "TOKEN" }],
    },
    dependabot: {
      secrets: [{ name: "DEPENDABOT", source: "DEPENDABOT" }],
    },
  };
  const left = currentState({
    actions: { secrets: ["TOKEN", "UNRELATED_A"] },
    dependabot: { secrets: ["DEPENDABOT", "UNRELATED_A"] },
  });
  const right = currentState({
    actions: { secrets: ["TOKEN", "UNRELATED_B"] },
    dependabot: { secrets: ["DEPENDABOT", "UNRELATED_B"] },
  });
  const plan = buildPlan(left, desired);

  assertEquals(
    projectOwnedCurrentState(left, desired, plan.operations),
    projectOwnedCurrentState(right, desired, plan.operations),
  );
});

Deno.test("environment secret names are dependencies only when update removes undeclared secrets", () => {
  const desiredExplicit: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    environments: [{
      name: "production",
      secrets: [{ name: "TOKEN", source: "TOKEN" }],
    }],
  };
  const left = currentState({
    environments: [{
      name: "production",
      secrets: ["TOKEN", "UNRELATED_A"],
      variables: [],
    }],
  });
  const right = currentState({
    environments: [{
      name: "production",
      secrets: ["TOKEN", "UNRELATED_B"],
      variables: [],
    }],
  });
  const explicitPlan = buildPlan(left, desiredExplicit);

  assertEquals(
    projectOwnedCurrentState(left, desiredExplicit, explicitPlan.operations),
    projectOwnedCurrentState(right, desiredExplicit, explicitPlan.operations),
  );

  const desiredClear: DesiredState = {
    ...desiredExplicit,
    environments: [{
      name: "production",
      secrets: [],
    }],
  };
  const clearPlan = buildPlan(left, desiredClear);

  assertNotEquals(
    projectOwnedCurrentState(left, desiredClear, clearPlan.operations),
    projectOwnedCurrentState(right, desiredClear, clearPlan.operations),
  );
});

Deno.test("file operations depend on the repository default branch", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    files: [{ path: "managed.txt", ensure: "exact", content: "target" }],
  };
  const leftBase = currentState();
  const left = currentState({
    settings: {
      ...leftBase.settings,
      defaultBranch: "main",
    },
    files: [{ path: "managed.txt", content: "old", sha: "sha-1" }],
  });
  const right = currentState({
    settings: {
      ...leftBase.settings,
      defaultBranch: "next",
    },
    files: [{ path: "managed.txt", content: "old", sha: "sha-1" }],
  });
  const plan = buildPlan(left, desired);

  assertNotEquals(
    projectOwnedCurrentState(left, desired, plan.operations),
    projectOwnedCurrentState(right, desired, plan.operations),
  );
});

Deno.test("explicit materialized rulesets track concurrently added rules", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    rulesets: [{
      name: "main",
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: true,
      }],
    }],
  };
  const baseRuleset = {
    id: 7,
    name: "main",
    target: "branch" as const,
    enforcement: "active" as const,
    bypassActors: [],
    conditions: {
      refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    },
    rules: [{
      type: "update" as const,
      updateAllowsFetchAndMerge: false,
    }],
  };
  const concurrentRuleset = {
    ...baseRuleset,
    rules: [
      ...baseRuleset.rules,
      {
        type: "required-linear-history" as const,
      },
    ],
  };
  const left = currentState({ rulesets: [baseRuleset] });
  const right = currentState({ rulesets: [concurrentRuleset] });
  const plan = buildPlan(left, desired);

  assertEquals(plan.operations[0]?.type, "update-ruleset");
  assertNotEquals(
    projectOwnedCurrentState(left, desired, plan.operations),
    projectOwnedCurrentState(right, desired, plan.operations),
  );
});

Deno.test("strict ruleset preconditions ignore contents of rules being removed", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    collections: "strict",
    rulesets: [{
      name: "main",
      rules: [{
        type: "update",
        updateAllowsFetchAndMerge: true,
      }],
    }],
  };
  const baseRuleset = {
    id: 7,
    name: "main",
    target: "branch" as const,
    enforcement: "active" as const,
    bypassActors: [],
    conditions: {
      refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    },
    rules: [
      {
        type: "update" as const,
        updateAllowsFetchAndMerge: false,
      },
      {
        type: "required-status-checks" as const,
        doNotEnforceOnCreate: false,
        checks: [{ context: "build" }],
        strict: false,
      },
    ],
  };
  const changedRuleset = {
    ...baseRuleset,
    rules: [
      baseRuleset.rules[0],
      {
        ...baseRuleset.rules[1],
        strict: true,
      },
    ],
  };
  const left = currentState({ rulesets: [baseRuleset] });
  const right = currentState({ rulesets: [changedRuleset] });
  const plan = buildPlan(left, desired);

  assertEquals(
    projectOwnedCurrentState(left, desired, plan.operations),
    projectOwnedCurrentState(right, desired, plan.operations),
  );
});

Deno.test("persisted apply rechecks state immediately before mutation", async () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    settings: { hasIssues: false },
  };
  const plannedCurrent = currentState();
  const plan = buildPlan(plannedCurrent, desired);
  const evaluations = buildApplyEvaluations(desired, plan.operations);
  const loaded: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: { scope: { include: { names: ["sample"] } } },
    },
    templates: {
      "repository:sample": {
        version: 1,
        kind: "repository",
        match: { include: { names: ["sample"] } },
        repository: { settings: { hasIssues: false } },
      },
    },
  };
  const artifact = await createPersistedPlanArtifact(
    loaded,
    [{ desired, current: plannedCurrent, plan, evaluations }],
    new Date("2026-09-24T12:00:00Z"),
  );

  let reads = 0;
  let applies = 0;
  const runtime = {
    discover: () =>
      Promise.resolve({
        repositories: [{
          name: "sample",
          teams: [],
          visibility: "private" as const,
          properties: {},
        }],
        failures: [],
      }),
    read: () => Promise.resolve(plannedCurrent),
    prepare: () => {},
    recheck: () => {
      reads++;
      throw new Error("Resource state changed after apply preparation");
    },
    apply: () => {
      applies++;
      throw new Error("apply must not be called after recheck drift");
    },
  };

  await applyPersistedPlan(runtime, loaded, artifact, () => {});
  assertEquals(reads, 1);
  assertEquals(applies, 0);
});

Deno.test("configuration precondition normalizes execution defaults", async () => {
  const baseLoaded: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: { include: { names: ["sample"] } },
      },
    },
    templates: {},
  };
  const explicitLoaded: LoadedConfiguration = {
    ...baseLoaded,
    configuration: {
      ...baseLoaded.configuration,
      repositories: {
        ...baseLoaded.configuration.repositories,
        settings: {
          collectionManagement: "explicit",
          unmatchedRepositories: "error",
        },
        fileChanges: {
          mode: "pull_request",
          commit: { message: "Octosmith: reconcile managed files" },
          pullRequest: {
            branchPrefix: "octosmith/",
            title: "Octosmith: reconcile managed files",
            labels: [],
          },
        },
      },
    },
  };

  const left = await createPersistedPlanArtifact(baseLoaded, []);
  const right = await createPersistedPlanArtifact(explicitLoaded, []);

  assertEquals(left.configuration, right.configuration);
});

Deno.test("configuration precondition treats pull-request labels as an unordered set", async () => {
  const loaded: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: { include: { names: ["sample"] } },
        fileChanges: {
          mode: "pull_request",
          pullRequest: { labels: ["automation", "managed"] },
        },
      },
    },
    templates: {},
  };
  const saved = await createPersistedPlanArtifact(loaded, []);
  for (
    const labels of [
      ["managed", "automation"],
      ["automation", "managed", "automation"],
      ["managed", "automation", "managed"],
      ["automation", "different"],
    ]
  ) {
    const candidate = await createPersistedPlanArtifact({
      ...loaded,
      configuration: {
        ...loaded.configuration,
        repositories: {
          ...loaded.configuration.repositories,
          fileChanges: { mode: "pull_request", pullRequest: { labels } },
        },
      },
    }, []);
    if (labels.includes("different")) {
      assertNotEquals(saved.configuration, candidate.configuration);
    } else {
      assertEquals(saved.configuration, candidate.configuration);
    }
  }
});

Deno.test("empty environment variable ownership tracks the whole collection", () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    environments: [{
      name: "production",
      variables: [],
    }],
  };
  const left = currentState({
    environments: [{
      name: "production",
      secrets: [],
      variables: [],
    }],
  });
  const right = currentState({
    environments: [{
      name: "production",
      secrets: [],
      variables: [{ name: "CONCURRENT", value: "new" }],
    }],
  });

  assertNotEquals(
    projectOwnedCurrentState(left, desired),
    projectOwnedCurrentState(right, desired),
  );
});

Deno.test("configuration precondition normalizes set-valued selectors", async () => {
  const first: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: {
          include: {
            names: ["b*", "a*"],
            teams: ["platform", "api"],
            visibility: ["private", "public"],
          },
        },
      },
    },
    templates: {},
  };
  const reordered: LoadedConfiguration = {
    ...first,
    configuration: {
      ...first.configuration,
      repositories: {
        ...first.configuration.repositories,
        scope: {
          include: {
            names: ["a*", "b*"],
            teams: ["api", "platform"],
            visibility: ["public", "private"],
          },
        },
      },
    },
  };
  const all: LoadedConfiguration = {
    ...first,
    configuration: {
      ...first.configuration,
      repositories: {
        ...first.configuration.repositories,
        scope: { include: "all" },
      },
    },
  };
  const empty: LoadedConfiguration = {
    ...all,
    configuration: {
      ...all.configuration,
      repositories: {
        ...all.configuration.repositories,
        scope: { include: {} },
      },
    },
  };

  assertEquals(
    (await createPersistedPlanArtifact(first, [])).configuration,
    (await createPersistedPlanArtifact(reordered, [])).configuration,
  );
  assertEquals(
    (await createPersistedPlanArtifact(all, [])).configuration,
    (await createPersistedPlanArtifact(empty, [])).configuration,
  );
});

Deno.test("configuration precondition normalizes scalar visibility like singleton arrays", async () => {
  const scalar: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: {
        scope: { include: { visibility: "public" } },
      },
    },
    templates: {},
  };
  const array: LoadedConfiguration = {
    ...scalar,
    configuration: {
      ...scalar.configuration,
      repositories: {
        ...scalar.configuration.repositories,
        scope: { include: { visibility: ["public"] } },
      },
    },
  };

  assertEquals(
    (await createPersistedPlanArtifact(scalar, [])).configuration,
    (await createPersistedPlanArtifact(array, [])).configuration,
  );
});

Deno.test("effective template hash normalizes planner-unordered arrays", async () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
  };
  const left = {
    version: 1 as const,
    kind: "repository" as const,
    match: {
      include: {
        names: ["b*", "a*"],
        teams: ["platform", "api"],
        visibility: ["private", "public"] as const,
      },
    },
    repository: {
      settings: {
        topics: ["github", "deno"],
      },
      customProperties: {
        tags: ["two", "one"],
      },
      actions: {
        selectedActions: {
          patternsAllowed: ["acme/b-*", "acme/a-*"],
        },
      },
    },
  };
  const right = {
    ...left,
    match: {
      include: {
        names: ["a*", "b*"],
        teams: ["api", "platform"],
        visibility: ["public", "private"] as const,
      },
    },
    repository: {
      ...left.repository,
      settings: {
        topics: ["deno", "github"],
      },
      customProperties: {
        tags: ["one", "two"],
      },
      actions: {
        selectedActions: {
          patternsAllowed: ["acme/a-*", "acme/b-*"],
        },
      },
    },
  };

  assertEquals(
    await hashEffectiveTemplate(left, desired),
    await hashEffectiveTemplate(right, desired),
  );
});

Deno.test("persisted template hash uses the planning file snapshot", async () => {
  const template = {
    version: 1 as const,
    kind: "repository" as const,
    match: { include: { names: ["sample"] } },
    repository: {
      files: {
        "managed.txt": {
          ensure: "exact" as const,
          source: "files/managed.txt",
        },
      },
    },
  };
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    files: [{
      path: "managed.txt",
      ensure: "exact",
      content: "planned-content",
    }],
  };
  const current = currentState({
    files: [{ path: "managed.txt", content: "old", sha: "sha-1" }],
  });
  const plan = buildPlan(current, desired);
  const evaluations = buildApplyEvaluations(desired, plan.operations);
  const loaded: LoadedConfiguration = {
    root: "/unused",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: { scope: { include: { names: ["sample"] } } },
    },
    templates: {
      "repository:sample": template,
    },
  };

  const artifact = await createPersistedPlanArtifact(
    loaded,
    [{ desired, current, plan, evaluations }],
    new Date("2026-09-24T12:00:00Z"),
  );

  assertEquals(
    artifact.resources[0].template.hash,
    (await hashCanonical({
      template,
      sources: { "files/managed.txt": "planned-content" },
    })).hash,
  );
});

Deno.test("persisted artifact stores exact operations without secret material", async () => {
  const desired: DesiredState = {
    repository: "sample",
    template: "repository:sample",
    actions: {
      variables: [{ name: "REGION", value: "eu-north-1" }],
      secrets: [{ name: "TOKEN", source: "DEPLOY_TOKEN" }],
    },
  };
  const current = currentState();
  const plan = buildPlan(current, desired);
  const evaluations = buildApplyEvaluations(desired, plan.operations);
  const loaded: LoadedConfiguration = {
    root: ".",
    configuration: {
      version: 1,
      organization: "acme",
      repositories: { scope: { include: { names: ["sample"] } } },
    },
    templates: {
      "repository:sample": {
        version: 1,
        kind: "repository",
        match: { include: { names: ["sample"] } },
        repository: {
          actions: {
            variables: ["REGION"],
            secrets: ["TOKEN"],
          },
        },
      },
    },
  };

  const artifact = await createPersistedPlanArtifact(
    loaded,
    [{ desired, current, plan, evaluations }],
    new Date("2026-09-24T12:00:00Z"),
  );

  assertEquals(artifact.format, "octosmith-plan");
  assertEquals(artifact.version, 1);
  assertEquals(artifact.resources[0].operations, plan.operations);
  assertEquals(
    JSON.stringify(artifact).includes("super-secret-value"),
    false,
  );
  assertEquals(
    artifact.resources[0].operations.some((operation) =>
      operation.type === "set-actions-variable" &&
      operation.variable.value === "eu-north-1"
    ),
    true,
  );
  assertEquals(
    artifact.resources[0].operations.some((operation) =>
      operation.type === "set-actions-secret" &&
      operation.secret.source === "DEPLOY_TOKEN"
    ),
    true,
  );
});

Deno.test("planner-preserved rule fields round-trip through create and update schemas", async () => {
  const cases = [
    { target: "branch", rule: { type: "required-linear-history" } },
    {
      target: "tag",
      rule: {
        type: "commit-message-pattern",
        operator: "contains",
        pattern: "expected",
        negate: true,
      },
    },
    {
      target: "branch",
      rule: {
        type: "pull-request",
        allowedMergeMethods: ["squash"],
        dismissalRestriction: {
          enabled: true,
          allowedActors: [{ id: 1, type: "team", extension: "actor" }],
          extension: "restriction",
        },
        requiredReviewers: [{
          reviewerTeamId: 1,
          filePatterns: ["*"],
          minimumApprovals: 1,
          extension: "reviewer",
        }],
      },
    },
    {
      target: "branch",
      rule: {
        type: "required-status-checks",
        doNotEnforceOnCreate: false,
        strict: true,
        checks: [{ context: "ci", integrationId: 1, extension: "check" }],
      },
    },
    {
      target: "branch",
      rule: {
        type: "workflows",
        doNotEnforceOnCreate: false,
        workflows: [{ path: "ci.yml", repositoryId: 1, extension: "workflow" }],
      },
    },
    {
      target: "branch",
      rule: {
        type: "code-scanning",
        tools: [{
          tool: "CodeQL",
          alertsThreshold: "errors",
          securityAlertsThreshold: "high-or-higher",
          extension: "tool",
        }],
      },
    },
    { target: "push", rule: { type: "max-file-size", maxFileSizeMb: 10 } },
  ];
  for (const { target, rule } of cases) {
    const definition = {
      name: "main",
      target,
      enforcement: "active",
      bypassActors: [],
      ...(target !== "push" &&
        { conditions: { refName: { include: [], exclude: [] } } }),
      rules: [{ ...rule, futureTopLevelField: { nested: ["preserved"] } }],
    } as unknown as import("../packages/octosmith/mod.ts").DesiredRuleset;
    const desired: DesiredState = {
      repository: "sample",
      template: "repository:sample",
      rulesets: [definition],
    };
    const loaded: LoadedConfiguration = {
      root: ".",
      configuration: {
        version: 1,
        organization: "acme",
        repositories: { scope: { include: "all" } },
      },
      templates: {
        "repository:sample": {
          version: 1,
          kind: "repository",
          match: { include: "all" },
          repository: {},
        },
      },
    };
    const empty = currentState();
    const create = buildPlan(empty, desired);
    const operation = create.operations[0];
    if (operation.type !== "create-ruleset") {
      throw new Error("Expected create-ruleset");
    }
    const existing = currentState({
      rulesets: [{ ...operation.ruleset, id: 7 }],
    });
    const updateDesired: DesiredState = {
      ...desired,
      rulesets: [{
        ...definition,
        rules: [
          ...definition.rules!,
          {
            type: target === "push"
              ? "file-path-restriction"
              : "required-signatures",
            ...(target === "push" && { restrictedFilePaths: ["private/**"] }),
          } as import("../packages/octosmith/mod.ts").DesiredRulesetRule,
        ],
      }],
    };
    const update = buildPlan(existing, updateDesired);
    for (
      const [current, resolved, plan] of [[empty, desired, create], [
        existing,
        updateDesired,
        update,
      ]] as const
    ) {
      const artifact = await createPersistedPlanArtifact(loaded, [{
        desired: resolved,
        current,
        plan,
        evaluations: buildApplyEvaluations(resolved, plan.operations),
      }]);
      const parsed = parsePersistedPlanArtifact(
        JSON.parse(JSON.stringify(artifact)),
      );
      assertEquals(parsed.resources[0].operations, plan.operations);
    }
  }
});

Deno.test("persisted artifact parsing rejects unsupported versions and invalid indexes", () => {
  const base = {
    format: "octosmith-plan",
    version: 1,
    createdAt: "2026-09-24T12:00:00Z",
    configuration: {
      algorithm: "sha256",
      hash: "0".repeat(64),
    },
    resources: [],
  };

  assertEquals(parsePersistedPlanArtifact(base).version, 1);

  const resource = {
    type: "repository" as const,
    name: "sample",
    template: {
      id: "repository:sample",
      algorithm: "sha256" as const,
      hash: "1".repeat(64),
    },
    state: {
      algorithm: "sha256" as const,
      hash: "2".repeat(64),
    },
    operations: [],
    evaluations: [],
  };
  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [resource, resource],
      }),
    Error,
    "duplicate resource identity repository:sample",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "set-custom-property",
            name: "owner",
            value: { invalid: true },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-ruleset",
            id: 1,
            changes: {
              name: "main",
              target: "invalid",
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-repository-settings",
            settings: { archived: "yes" },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-ruleset",
            id: 1,
            changes: {
              name: "main",
              rules: [{
                type: "required-status-checks",
                checks: [],
                strict: false,
              }],
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "create-ruleset",
            ruleset: {
              name: "push-only-mismatch",
              target: "branch",
              enforcement: "active",
              bypassActors: [],
              conditions: {
                refName: { include: [], exclude: [] },
              },
              rules: [{
                type: "max-file-size",
                maxFileSizeMb: 10,
              }],
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-actions-settings",
            settings: {
              oidc: {
                immutableSubject: true,
              },
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-ruleset",
            id: 1,
            changes: {
              name: "main",
              target: "push",
              conditions: {
                refName: { include: [], exclude: [] },
              },
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-ruleset",
            id: 1,
            changes: {
              name: "main",
              target: "push",
              rules: [{
                type: "required-linear-history",
              }],
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-ruleset",
            id: 1,
            changes: {
              name: "main",
              rules: [{
                type: "required-linear-history",
              }],
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "update-ruleset",
            id: 1,
            changes: {
              name: "main",
              target: "branch",
              conditions: {},
            },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  for (
    const operation of [
      {
        type: "update-file",
        sha: "",
        file: {
          path: "managed.txt",
          ensure: "exact",
          content: "content",
        },
      },
      {
        type: "delete-file",
        path: "managed.txt",
        sha: "",
      },
    ]
  ) {
    assertThrows(
      () =>
        parsePersistedPlanArtifact({
          ...base,
          resources: [{
            type: "repository",
            name: "sample",
            template: {
              id: "repository:sample",
              algorithm: "sha256",
              hash: "1".repeat(64),
            },
            state: {
              algorithm: "sha256",
              hash: "2".repeat(64),
            },
            operations: [operation],
            evaluations: [],
          }],
        }),
      Error,
      "Invalid persisted plan",
    );
  }

  assertThrows(
    () => parsePersistedPlanArtifact({ ...base, version: 2 }),
    Error,
    "Unsupported persisted plan version: 2",
  );

  assertThrows(
    () => parsePersistedPlanArtifact({ ...base, createdAt: "not-a-date" }),
    Error,
    "createdAt must be an RFC 3339 date-time",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [],
          evaluations: [{
            type: "repository-settings",
            details: {},
            operationIndex: 0,
          }],
        }],
      }),
    Error,
    "operationIndex is out of range",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{ type: "update-repository-settings" }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );

  assertThrows(
    () =>
      parsePersistedPlanArtifact({
        ...base,
        resources: [{
          type: "repository",
          name: "sample",
          template: {
            id: "repository:sample",
            algorithm: "sha256",
            hash: "1".repeat(64),
          },
          state: {
            algorithm: "sha256",
            hash: "2".repeat(64),
          },
          operations: [{
            type: "create-ruleset",
            ruleset: { name: "incomplete" },
          }],
          evaluations: [],
        }],
      }),
    Error,
    "Invalid persisted plan",
  );
});
