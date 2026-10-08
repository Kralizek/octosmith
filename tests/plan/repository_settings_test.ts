import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  diffRepositorySettings,
  projectOwnedCurrentState,
} from "../../packages/octosmith/mod.ts";
import { currentRepositorySettings, currentState } from "./fixtures.ts";

Deno.test("repository settings ignore unmanaged fields", () => {
  assertEquals(
    diffRepositorySettings(currentRepositorySettings(), { hasIssues: true }),
    undefined,
  );
});

Deno.test("repository settings emit scalar, nullable, merge and security drift", () => {
  assertEquals(
    diffRepositorySettings(currentRepositorySettings(), {
      description: null,
      website: "https://example.com",
      visibility: "public",
      hasIssues: false,
      hasProjects: true,
      hasWiki: true,
      hasDiscussions: true,
      hasPullRequests: false,
      pullRequestCreationPolicy: "collaborators-only",
      isTemplate: true,
      defaultBranch: "trunk",
      archived: true,
      allowForking: true,
      webCommitSignoffRequired: false,
      merge: {
        allowSquashMerge: false,
        allowMergeCommit: true,
        allowRebaseMerge: true,
        allowAutoMerge: true,
        allowUpdateBranch: false,
        deleteBranchOnMerge: false,
        squashMergeCommitTitle: "commit-or-pull-request-title",
        squashMergeCommitMessage: "commit-messages",
        mergeCommitTitle: "merge-message",
        mergeCommitMessage: "blank",
      },
      securityAndAnalysis: {
        advancedSecurity: "disabled",
        codeSecurity: "enabled",
        secretScanning: "disabled",
        secretScanningPushProtection: "disabled",
        secretScanningAiDetection: "enabled",
      },
    }),
    {
      description: null,
      website: "https://example.com",
      visibility: "public",
      hasIssues: false,
      hasProjects: true,
      hasWiki: true,
      hasDiscussions: true,
      hasPullRequests: false,
      pullRequestCreationPolicy: "collaborators-only",
      isTemplate: true,
      defaultBranch: "trunk",
      archived: true,
      allowForking: true,
      webCommitSignoffRequired: false,
      merge: {
        allowSquashMerge: false,
        allowMergeCommit: true,
        allowRebaseMerge: true,
        allowAutoMerge: true,
        allowUpdateBranch: false,
        deleteBranchOnMerge: false,
        squashMergeCommitTitle: "commit-or-pull-request-title",
        squashMergeCommitMessage: "commit-messages",
        mergeCommitTitle: "merge-message",
        mergeCommitMessage: "blank",
      },
      securityAndAnalysis: {
        advancedSecurity: "disabled",
        codeSecurity: "enabled",
        secretScanning: "disabled",
        secretScanningPushProtection: "disabled",
        secretScanningAiDetection: "enabled",
      },
    },
  );
});

Deno.test("repository topics are unordered", () => {
  assertEquals(
    diffRepositorySettings(currentRepositorySettings(), {
      topics: ["github", "deno"],
    }),
    undefined,
  );
  assertEquals(
    diffRepositorySettings(currentRepositorySettings(), {
      topics: ["github", "octosmith"],
    }),
    { topics: ["github", "octosmith"] },
  );
});

Deno.test("repository settings reject invalid effective squash pairs without changing unmanaged settings", () => {
  const settings = currentRepositorySettings();
  const current = {
    ...settings,
    merge: {
      ...settings.merge,
      squashMergeCommitTitle: "commit-or-pull-request-title" as const,
      squashMergeCommitMessage: "commit-messages" as const,
    },
  };
  for (const message of ["blank", "pull-request-body"] as const) {
    const error = assertThrows(
      () =>
        diffRepositorySettings(current, {
          merge: { squashMergeCommitMessage: message },
        }),
      Error,
      "invalid squash merge title/message combination",
    );
    assertStringIncludes(error.message, "Repository " + current.name);
    assertStringIncludes(
      error.message,
      "Current: commit-or-pull-request-title / commit-messages",
    );
    assertStringIncludes(
      error.message,
      "effective: commit-or-pull-request-title / " + message,
    );
    assertStringIncludes(error.message, "Supported combinations:");
    assertStringIncludes(error.message, "Explicitly configure both settings");
  }
  assertEquals(
    diffRepositorySettings(current, {
      merge: {
        squashMergeCommitTitle: "pull-request-title",
        squashMergeCommitMessage: "blank",
      },
    }),
    {
      merge: {
        squashMergeCommitTitle: "pull-request-title",
        squashMergeCommitMessage: "blank",
      },
    },
  );
  assertEquals(
    diffRepositorySettings(current, {
      merge: { squashMergeCommitTitle: "pull-request-title" },
    }),
    { merge: { squashMergeCommitTitle: "pull-request-title" } },
  );
  assertEquals(
    diffRepositorySettings(settings, {
      merge: { squashMergeCommitMessage: "blank" },
    }),
    { merge: { squashMergeCommitMessage: "blank" } },
  );
  assertEquals(
    diffRepositorySettings(current, { merge: { allowSquashMerge: false } }),
    { merge: { allowSquashMerge: false } },
  );
});

Deno.test("repository settings reject title-only changes that conflict with the current message", () => {
  assertThrows(
    () =>
      diffRepositorySettings(currentRepositorySettings(), {
        merge: { squashMergeCommitTitle: "commit-or-pull-request-title" },
      }),
    Error,
    "effective: commit-or-pull-request-title / pull-request-body",
  );
});

Deno.test("squash pair preconditions track the unmanaged counterpart", () => {
  const current = currentState();
  for (
    const merge of [
      { squashMergeCommitMessage: "blank" as const },
      { squashMergeCommitTitle: "commit-or-pull-request-title" as const },
    ]
  ) {
    const desired = {
      repository: current.repository,
      template: "repository:code",
      settings: { merge },
    };
    const changed = {
      ...current,
      settings: {
        ...current.settings,
        merge: {
          ...current.settings.merge,
          squashMergeCommitTitle: "commit-or-pull-request-title" as const,
          squashMergeCommitMessage: "commit-messages" as const,
        },
      },
    };
    const projected = projectOwnedCurrentState(current, desired);
    assertEquals(projected.settings, {
      merge: {
        squashMergeCommitTitle: current.settings.merge.squashMergeCommitTitle,
        squashMergeCommitMessage:
          current.settings.merge.squashMergeCommitMessage,
      },
    });
    assertNotEquals(projected, projectOwnedCurrentState(changed, desired));
  }
});
