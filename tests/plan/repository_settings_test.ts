import { assertEquals } from "@std/assert";
import { diffRepositorySettings } from "../../packages/octosmith/mod.ts";
import { currentRepositorySettings } from "./fixtures.ts";

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
