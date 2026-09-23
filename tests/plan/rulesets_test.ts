import { assertEquals, assertThrows } from "@std/assert";
import { buildPlan } from "../../packages/octosmith/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("rulesets create complete push rulesets", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "push-policy",
        target: "push",
        enforcement: "active",
        bypassActors: [{
          actorType: "team",
          actorId: 42,
          bypassMode: "always",
        }],
        rules: [{
          type: "max-file-size",
          maxFileSizeMb: 10,
        }],
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
          bypassActors: [{
            actorType: "team",
            actorId: 42,
            bypassMode: "always",
          }],
          rules: [{ type: "max-file-size", maxFileSizeMb: 10 }],
        },
      }],
    },
  );
});

Deno.test("ruleset creation validates required fields and ref conditions", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{ name: "missing-target" }],
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
          name: "missing-enforcement",
          target: "push",
        }],
      }),
    Error,
    "requires enforcement",
  );
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "branch",
          target: "branch",
          enforcement: "active",
        }],
      }),
    Error,
    "requires conditions.refName",
  );
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "push",
          target: "push",
          enforcement: "active",
          conditions: { refName: { include: ["~DEFAULT_BRANCH"] } },
        }],
      }),
    Error,
    "cannot declare ref conditions",
  );
});

Deno.test("ruleset explicit updates preserve unowned fields and sibling rules", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "branch",
      enforcement: "active",
      bypassActors: [{
        actorType: "team",
        actorId: 1,
        bypassMode: "always",
      }],
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

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "protect",
        enforcement: "evaluate",
        conditions: {
          refName: { exclude: ["refs/heads/generated"] },
        },
        rules: [{
          type: "update",
          updateAllowsFetchAndMerge: true,
        }],
      }],
    }),
    {
      repository: "sample",
      operations: [{
        type: "update-ruleset",
        id: 1,
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
      }],
    },
  );
});

Deno.test("buildPlan does not mutate ruleset inputs during explicit merges", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "branch",
      enforcement: "active",
      bypassActors: [{
        actorType: "team",
        actorId: 1,
        bypassMode: "always",
      }],
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: [],
        },
      },
      rules: [
        {
          type: "required-status-checks",
          doNotEnforceOnCreate: false,
          checks: [{ context: "ci", integrationId: 123 }],
          strict: true,
        },
        { type: "deletion" },
      ],
    }],
  });
  const desired = {
    repository: "sample",
    template: "code",
    rulesets: [{
      name: "protect",
      conditions: {
        refName: {
          exclude: ["refs/heads/generated"],
        },
      },
      rules: [{
        type: "required-status-checks",
        strict: false,
      }],
    }],
  } as const;
  const currentSnapshot = structuredClone(current);
  const desiredSnapshot = structuredClone(desired);

  const plan = buildPlan(current, desired);

  assertEquals(current, currentSnapshot);
  assertEquals(desired, desiredSnapshot);
  assertEquals(plan.operations, [{
    type: "update-ruleset",
    id: 1,
    changes: {
      name: "protect",
      conditions: {
        refName: {
          include: ["~DEFAULT_BRANCH"],
          exclude: ["refs/heads/generated"],
        },
      },
      rules: [
        {
          type: "required-status-checks",
          doNotEnforceOnCreate: false,
          checks: [{ context: "ci", integrationId: 123 }],
          strict: false,
        },
        { type: "deletion" },
      ],
    },
  }]);
});

Deno.test("ruleset bypass actors and target drift are planned", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [],
    }],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "protect",
        target: "tag",
        bypassActors: [{
          actorType: "team",
          actorId: 7,
          bypassMode: "pull-request",
        }],
      }],
    }),
    {
      repository: "sample",
      operations: [{
        type: "update-ruleset",
        id: 1,
        changes: {
          name: "protect",
          target: "tag",
          bypassActors: [{
            actorType: "team",
            actorId: 7,
            bypassMode: "pull-request",
          }],
          conditions: {
            refName: {
              include: [],
              exclude: [],
            },
          },
        },
      }],
    },
  );
});

Deno.test("push rulesets reject ref conditions on update", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState({
          rulesets: [{
            id: 1,
            name: "push",
            target: "push",
            enforcement: "active",
            bypassActors: [],
            rules: [],
          }],
        }),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "push",
            conditions: { refName: { include: ["~DEFAULT_BRANCH"] } },
          }],
        },
      ),
    Error,
    "cannot declare ref conditions",
  );
});

Deno.test("rulesets and nested rules are explicit by default and authoritative in strict mode", () => {
  const current = currentState({
    rulesets: [
      {
        id: 1,
        name: "keep",
        target: "push",
        enforcement: "active",
        bypassActors: [],
        rules: [
          { type: "max-file-size", maxFileSizeMb: 10 },
          {
            type: "file-path-restriction",
            restrictedFilePaths: ["secrets/**"],
          },
        ],
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
  });
  const desired = {
    repository: "sample",
    template: "code",
    rulesets: [{
      name: "keep",
      rules: [{ type: "max-file-size", maxFileSizeMb: 20 }],
    }],
  } as const;

  assertEquals(buildPlan(current, desired), {
    repository: "sample",
    operations: [{
      type: "update-ruleset",
      id: 1,
      changes: {
        name: "keep",
        rules: [
          { type: "max-file-size", maxFileSizeMb: 20 },
          {
            type: "file-path-restriction",
            restrictedFilePaths: ["secrets/**"],
          },
        ],
      },
    }],
  });

  assertEquals(buildPlan(current, { ...desired, collections: "strict" }), {
    repository: "sample",
    operations: [
      { type: "delete-ruleset", id: 2, name: "remove" },
      {
        type: "update-ruleset",
        id: 1,
        changes: {
          name: "keep",
          rules: [{ type: "max-file-size", maxFileSizeMb: 20 }],
        },
      },
    ],
  });
});

Deno.test("empty rulesets and empty rules are non-destructive in explicit mode", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [{ type: "max-file-size", maxFileSizeMb: 10 }],
    }],
  });

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      rulesets: [],
    }),
    { repository: "sample", operations: [] },
  );

  assertEquals(
    buildPlan(current, {
      repository: "sample",
      template: "code",
      rulesets: [{ name: "protect", rules: [] }],
    }),
    { repository: "sample", operations: [] },
  );
});

Deno.test("strict empty rulesets and rules clear owned collections", () => {
  const current = currentState({
    rulesets: [{
      id: 1,
      name: "protect",
      target: "push",
      enforcement: "active",
      bypassActors: [],
      rules: [{ type: "max-file-size", maxFileSizeMb: 10 }],
    }],
  });

  assertEquals(
    buildPlan(
      current,
      {
        repository: "sample",
        template: "code",
        collections: "strict",
        rulesets: [],
      },
    ),
    {
      repository: "sample",
      operations: [{ type: "delete-ruleset", id: 1, name: "protect" }],
    },
  );

  assertEquals(
    buildPlan(
      current,
      {
        repository: "sample",
        template: "code",
        collections: "strict",
        rulesets: [{ name: "protect", rules: [] }],
      },
    ),
    {
      repository: "sample",
      operations: [{
        type: "update-ruleset",
        id: 1,
        changes: { name: "protect", rules: [] },
      }],
    },
  );
});

Deno.test("rulesets reject duplicate names and duplicate rule types", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [
          {
            name: "same",
            target: "push",
            enforcement: "active",
            rules: [],
          },
          {
            name: "same",
            target: "push",
            enforcement: "active",
            rules: [],
          },
        ],
      }),
    Error,
    "Duplicate ruleset: same",
  );

  assertThrows(
    () =>
      buildPlan(
        currentState({
          rulesets: [{
            id: 1,
            name: "protect",
            target: "push",
            enforcement: "active",
            bypassActors: [],
            rules: [],
          }],
        }),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "protect",
            rules: [
              { type: "max-file-size", maxFileSizeMb: 10 },
              { type: "max-file-size", maxFileSizeMb: 20 },
            ],
          }],
        },
      ),
    Error,
    "Duplicate ruleset rule type: max-file-size",
  );
});

Deno.test("ruleset conditions validate against the effective target", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState({
          rulesets: [{
            id: 1,
            name: "protect",
            target: "branch",
            enforcement: "active",
            bypassActors: [],
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
            },
            rules: [],
          }],
        }),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "protect",
            target: "push",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
          }],
        },
      ),
    Error,
    "cannot declare ref conditions",
  );

  assertEquals(
    buildPlan(
      currentState({
        rulesets: [{
          id: 1,
          name: "protect",
          target: "push",
          enforcement: "active",
          bypassActors: [],
          rules: [],
        }],
      }),
      {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "protect",
          target: "branch",
          conditions: {
            refName: { include: ["~DEFAULT_BRANCH"] },
          },
        }],
      },
    ),
    {
      repository: "sample",
      operations: [{
        type: "update-ruleset",
        id: 1,
        changes: {
          name: "protect",
          target: "branch",
          conditions: {
            refName: {
              include: ["~DEFAULT_BRANCH"],
              exclude: [],
            },
          },
        },
      }],
    },
  );
});

Deno.test("new rules must be complete before entering a plan", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState({
          rulesets: [{
            id: 1,
            name: "protect",
            target: "branch",
            enforcement: "active",
            bypassActors: [],
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"], exclude: [] },
            },
            rules: [],
          }],
        }),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "protect",
            rules: [{ type: "update" }],
          }],
        },
      ),
    Error,
    "requires updateAllowsFetchAndMerge",
  );

  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "push",
          target: "push",
          enforcement: "active",
          rules: [{ type: "max-file-size" }],
        }],
      }),
    Error,
    "requires maxFileSizeMb",
  );
});

Deno.test("new rules reject types incompatible with the ruleset target", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "branch",
          target: "branch",
          enforcement: "active",
          conditions: {
            refName: { include: ["~DEFAULT_BRANCH"] },
          },
          rules: [{ type: "max-file-size", maxFileSizeMb: 10 }],
        }],
      }),
    Error,
    "not valid for branch rulesets",
  );
});

Deno.test("new pull-request rules default optional fields", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "branch",
        target: "branch",
        enforcement: "active",
        conditions: {
          refName: { include: ["~DEFAULT_BRANCH"] },
        },
        rules: [{
          type: "pull-request",
          allowedMergeMethods: ["squash"],
          requiredReviewThreadResolution: true,
        }],
      }],
    }),
    {
      repository: "sample",
      operations: [{
        type: "create-ruleset",
        ruleset: {
          name: "branch",
          target: "branch",
          enforcement: "active",
          bypassActors: [],
          conditions: {
            refName: {
              include: ["~DEFAULT_BRANCH"],
              exclude: [],
            },
          },
          rules: [{
            type: "pull-request",
            allowedMergeMethods: ["squash"],
            dismissStaleReviewsOnPush: false,
            dismissalRestriction: {
              enabled: false,
              allowedActors: [],
            },
            requireCodeOwnerReview: false,
            requireLastPushApproval: false,
            requiredApprovingReviewCount: 0,
            requiredReviewThreadResolution: true,
            requiredReviewers: [],
          }],
        },
      }],
    },
  );
});

Deno.test("new pull-request rules validate declared nested objects", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "branch",
          target: "branch",
          enforcement: "active",
          conditions: {
            refName: { include: ["~DEFAULT_BRANCH"] },
          },
          rules: [{
            type: "pull-request",
            allowedMergeMethods: ["squash"],
            dismissalRestriction: {
              enabled: true,
            },
          }],
        }],
      }),
    Error,
    "requires complete dismissalRestriction",
  );
});

Deno.test("ruleset creation rejects duplicate rule types", () => {
  assertThrows(
    () =>
      buildPlan(currentState(), {
        repository: "sample",
        template: "code",
        rulesets: [{
          name: "push",
          target: "push",
          enforcement: "active",
          rules: [
            { type: "max-file-size", maxFileSizeMb: 10 },
            { type: "max-file-size", maxFileSizeMb: 20 },
          ],
        }],
      }),
    Error,
    "Duplicate ruleset rule type: max-file-size",
  );
});

Deno.test("target transitions validate preserved rules even when rules are omitted", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState({
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
            rules: [{ type: "deletion" }],
          }],
        }),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "protect",
            target: "push",
          }],
        },
      ),
    Error,
    "not valid for push rulesets",
  );
});

Deno.test("push to ref target transition materializes empty ref conditions", () => {
  const plan = buildPlan(
    currentState({
      rulesets: [{
        id: 1,
        name: "protect",
        target: "push",
        enforcement: "active",
        bypassActors: [],
        rules: [],
      }],
    }),
    {
      repository: "sample",
      template: "code",
      rulesets: [{
        name: "protect",
        target: "branch",
      }],
    },
  );

  assertEquals(plan.operations, [{
    type: "update-ruleset",
    id: 1,
    changes: {
      name: "protect",
      target: "branch",
      conditions: {
        refName: {
          include: [],
          exclude: [],
        },
      },
    },
  }]);
});

Deno.test("existing matching rules are validated after merge against the effective target", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState({
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
            rules: [{ type: "deletion" }],
          }],
        }),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "protect",
            target: "push",
            rules: [{ type: "deletion" }],
          }],
        },
      ),
    Error,
    "not valid for push rulesets",
  );
});

Deno.test("ruleset required fields reject null values", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "push",
            target: "push",
            enforcement: "active",
            rules: [{
              type: "max-file-size",
              maxFileSizeMb: null,
            }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "requires maxFileSizeMb",
  );

  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "branch",
            target: "branch",
            enforcement: "active",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
            rules: [{
              type: "required-status-checks",
              doNotEnforceOnCreate: false,
              checks: [{ context: null }],
              strict: true,
            }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "required status check at index 0 requires context",
  );
});

Deno.test("unsupported ruleset rule types are rejected", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "branch",
            target: "branch",
            enforcement: "active",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
            rules: [{ type: "future-rule" }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "Unsupported ruleset rule type: future-rule",
  );
});

Deno.test("new rules validate nested object members", () => {
  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "branch",
            target: "branch",
            enforcement: "active",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
            rules: [{
              type: "required-status-checks",
              doNotEnforceOnCreate: false,
              checks: [{}],
              strict: true,
            }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "required status check at index 0 requires context",
  );

  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "branch",
            target: "branch",
            enforcement: "active",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
            rules: [{
              type: "workflows",
              doNotEnforceOnCreate: false,
              workflows: [{ path: ".github/workflows/ci.yml" }],
            }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "required workflow at index 0 requires repositoryId",
  );

  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "branch",
            target: "branch",
            enforcement: "active",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
            rules: [{
              type: "pull-request",
              allowedMergeMethods: ["squash"],
              dismissStaleReviewsOnPush: true,
              dismissalRestriction: {
                enabled: true,
                allowedActors: [],
              },
              requireCodeOwnerReview: true,
              requireLastPushApproval: true,
              requiredApprovingReviewCount: 1,
              requiredReviewThreadResolution: true,
              requiredReviewers: [{ reviewerTeamId: 7 }],
            }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "pull-request required reviewer at index 0 requires filePatterns",
  );

  assertThrows(
    () =>
      buildPlan(
        currentState(),
        {
          repository: "sample",
          template: "code",
          rulesets: [{
            name: "branch",
            target: "branch",
            enforcement: "active",
            conditions: {
              refName: { include: ["~DEFAULT_BRANCH"] },
            },
            rules: [{
              type: "code-scanning",
              tools: [{
                tool: "CodeQL",
                alertsThreshold: "errors",
              }],
            }],
          }],
        } as unknown as import("../../packages/octosmith/mod.ts").DesiredState,
      ),
    Error,
    "code scanning tool at index 0 requires securityAlertsThreshold",
  );
});
