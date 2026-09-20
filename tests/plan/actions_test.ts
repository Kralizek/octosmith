import { assertEquals } from "@std/assert";
import { buildPlan } from "../../packages/octosmith/mod.ts";
import { currentState } from "./fixtures.ts";

Deno.test("actions scalar settings emit only drift", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      actions: {
        enabled: false,
        allowedActions: "selected",
        shaPinningRequired: true,
      },
    }),
    {
      repository: "sample",
      operations: [{
        type: "update-actions-settings",
        settings: {
          enabled: false,
          allowedActions: "selected",
          shaPinningRequired: true,
        },
      }],
    },
  );
});

Deno.test("selected actions compare patterns unordered and handle missing current selection", () => {
  const desired = {
    repository: "sample",
    template: "code",
    actions: {
      selectedActions: {
        githubOwnedAllowed: true,
        verifiedAllowed: false,
        patternsAllowed: ["b/*", "a/*"],
      },
    },
  } as const;

  assertEquals(
    buildPlan(
      currentState({
        actions: {
          enabled: true,
          allowedActions: "selected",
          shaPinningRequired: false,
          selectedActions: {
            githubOwnedAllowed: true,
            verifiedAllowed: false,
            patternsAllowed: ["a/*", "b/*"],
          },
          oidc: {
            subjectClaimTemplate: { source: "default" },
            immutableSubject: false,
          },
        },
      }),
      desired,
    ),
    { repository: "sample", operations: [] },
  );

  assertEquals(
    buildPlan(currentState(), desired),
    {
      repository: "sample",
      operations: [{
        type: "update-actions-settings",
        settings: {
          allowedActions: "selected",
          selectedActions: {
            githubOwnedAllowed: true,
            verifiedAllowed: false,
            patternsAllowed: ["b/*", "a/*"],
          },
        },
      }],
    },
  );
});

Deno.test("actions OIDC emits only owned drift", () => {
  assertEquals(
    buildPlan(currentState(), {
      repository: "sample",
      template: "code",
      actions: {
        oidc: {
          subjectClaimTemplate: { source: "custom", claims: ["repo"] },
          immutableSubject: true,
        },
      },
    }),
    {
      repository: "sample",
      operations: [{
        type: "update-actions-oidc",
        settings: {
          subjectClaimTemplate: { source: "custom", claims: ["repo"] },
          immutableSubject: true,
        },
      }],
    },
  );
});
