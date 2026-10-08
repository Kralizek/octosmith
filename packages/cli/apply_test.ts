import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildApplyEvaluations,
  buildPlan,
  type CurrentState,
  type DesiredState,
  loadConfigurationDirectory,
  renderReport,
  reportPlannedRepository,
  type RepositoryReport,
} from "@octosmith/octosmith";
import { apply, type ApplyRuntime } from "./apply.ts";

Deno.test(
  "apply abort reports skipped operations for prepared repositories",
  async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/templates`);
      await Deno.writeTextFile(
        `${root}/octosmith.yml`,
        "version: 1\norganization: example-org\nrepositories:\n  scope:\n    include: all\n",
      );
      await Deno.writeTextFile(
        `${root}/templates/sample.yml`,
        "version: 1\nkind: repository\nmatch:\n  include: all\nrepository:\n  customProperties:\n    unchanged: same\n    changed: after\n",
      );
      const loaded = await loadConfigurationDirectory(root);
      const reports: RepositoryReport[] = [];
      const runtime: ApplyRuntime = {
        discover: () =>
          Promise.resolve({
            repositories: ["prepared", "read-failure"].map((name) => ({
              name,
              teams: [],
              properties: {},
            })),
            failures: [],
          }),
        read: (desired) => {
          if (desired.repository === "read-failure") {
            throw new Error("state read failed");
          }
          return Promise.resolve(
            currentState(desired.repository, {
              unchanged: "same",
              changed: "before",
            }),
          );
        },
        prepare: () => {},
        recheck: () => {},
        apply: () => {
          throw new Error("apply must not run after a preparation failure");
        },
      };

      await apply(runtime, loaded, {
        mode: "apply",
        onRepositoryApplied: (report) => {
          reports.push(report);
        },
      });

      const preparedReport = reports.find((report) =>
        report.repository === "prepared"
      );
      assertEquals(preparedReport?.status, "failed");
      assertEquals(
        preparedReport?.items.find((item) => item.details.name === "changed")
          ?.status,
        "skipped",
      );
      assertEquals(
        preparedReport?.items.find((item) => item.details.name === "unchanged")
          ?.status,
        "unchanged",
      );

      const rendered = renderReport({
        organization: "example-org",
        startedAt: new Date(0),
        completedAt: new Date(0),
        mode: "apply",
        repositories: reports,
      });
      assertStringIncludes(
        rendered,
        "Operations:   0 planned, 0 applied, 0 failed, 1 skipped",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test("team permission transitions retain permission kind", () => {
  const current = currentState("example-repo", {}, [{
    team: "developers",
    permission: { kind: "built-in", name: "push" },
  }]);
  const desired: DesiredState = {
    repository: "example-repo",
    template: "sample",
    teams: [{
      team: "developers",
      permission: { kind: "custom", name: "push" },
    }],
  };
  const plan = buildPlan(current, desired);
  const evaluations = buildApplyEvaluations(
    desired,
    plan.operations,
    current,
  );
  const repositoryReport = reportPlannedRepository(
    desired.template,
    plan,
    evaluations,
  );
  const rendered = renderReport({
    organization: "example-org",
    startedAt: new Date(0),
    completedAt: new Date(0),
    repositories: [repositoryReport],
  });

  assertStringIncludes(rendered, "push → custom: push");
  assertEquals(evaluations[0].details.beforePermissionKind, "built-in");
  assertEquals(evaluations[0].details.permissionKind, "custom");
});

function currentState(
  repository: string,
  customProperties: CurrentState["customProperties"] = {},
  teams: CurrentState["teams"] = [],
): CurrentState {
  return {
    repository,
    settings: {
      name: repository,
      description: null,
      website: null,
      topics: [],
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
      allowForking: true,
      webCommitSignoffRequired: false,
      securityAndAnalysis: {},
    },
    customProperties,
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
    teams,
    rulesets: [],
    environments: [],
    files: [],
  };
}
