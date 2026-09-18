import type { Operation, Plan } from "./types.ts";
import type {
  CurrentRepositorySettings,
  DesiredMergeSettings,
  DesiredRepositorySettings,
  DesiredSecurityAndAnalysis,
} from "../state/repository.ts";
import type { CurrentState, DesiredState } from "../state/types.ts";

export function buildPlan(
  current: CurrentState,
  desired: DesiredState,
): Plan {
  if (current.repository !== desired.repository) {
    throw new Error(
      "Cannot build a plan for different repositories: " +
        current.repository + " and " + desired.repository,
    );
  }

  assertSupportedDesiredState(desired);

  const operations: Operation[] = [];

  if (desired.settings) {
    const changes = diffRepositorySettings(current.settings, desired.settings);

    if (changes) {
      operations.push({
        type: "update-repository-settings",
        settings: changes,
      });
    }
  }

  return {
    repository: desired.repository,
    operations,
  };
}

export function diffRepositorySettings(
  current: CurrentRepositorySettings,
  desired: DesiredRepositorySettings,
): DesiredRepositorySettings | undefined {
  const changes: Record<string, unknown> = {};

  copyChangedScalar(current, desired, changes, "description");
  copyChangedScalar(current, desired, changes, "website");

  if (
    desired.topics !== undefined &&
    !equalUnorderedStrings(current.topics, desired.topics)
  ) {
    changes.topics = desired.topics;
  }

  copyChangedScalar(current, desired, changes, "visibility");
  copyChangedScalar(current, desired, changes, "hasIssues");
  copyChangedScalar(current, desired, changes, "hasProjects");
  copyChangedScalar(current, desired, changes, "hasWiki");
  copyChangedScalar(current, desired, changes, "hasDiscussions");
  copyChangedScalar(current, desired, changes, "hasPullRequests");
  copyChangedScalar(
    current,
    desired,
    changes,
    "pullRequestCreationPolicy",
  );
  copyChangedScalar(current, desired, changes, "isTemplate");
  copyChangedScalar(current, desired, changes, "defaultBranch");
  copyChangedScalar(current, desired, changes, "archived");
  copyChangedScalar(current, desired, changes, "allowForking");
  copyChangedScalar(
    current,
    desired,
    changes,
    "webCommitSignoffRequired",
  );

  if (desired.merge) {
    const merge = diffMergeSettings(current.merge, desired.merge);

    if (merge) {
      changes.merge = merge;
    }
  }

  if (desired.securityAndAnalysis) {
    const securityAndAnalysis = diffSecurityAndAnalysis(
      current.securityAndAnalysis,
      desired.securityAndAnalysis,
    );

    if (securityAndAnalysis) {
      changes.securityAndAnalysis = securityAndAnalysis;
    }
  }

  return Object.keys(changes).length > 0
    ? changes as DesiredRepositorySettings
    : undefined;
}

function diffMergeSettings(
  current: CurrentRepositorySettings["merge"],
  desired: DesiredMergeSettings,
): DesiredMergeSettings | undefined {
  const changes: Record<string, unknown> = {};

  copyChangedScalar(current, desired, changes, "allowSquashMerge");
  copyChangedScalar(current, desired, changes, "allowMergeCommit");
  copyChangedScalar(current, desired, changes, "allowRebaseMerge");
  copyChangedScalar(current, desired, changes, "allowAutoMerge");
  copyChangedScalar(current, desired, changes, "allowUpdateBranch");
  copyChangedScalar(current, desired, changes, "deleteBranchOnMerge");
  copyChangedScalar(
    current,
    desired,
    changes,
    "squashMergeCommitTitle",
  );
  copyChangedScalar(
    current,
    desired,
    changes,
    "squashMergeCommitMessage",
  );
  copyChangedScalar(current, desired, changes, "mergeCommitTitle");
  copyChangedScalar(current, desired, changes, "mergeCommitMessage");

  return Object.keys(changes).length > 0
    ? changes as DesiredMergeSettings
    : undefined;
}

function diffSecurityAndAnalysis(
  current: CurrentRepositorySettings["securityAndAnalysis"],
  desired: DesiredSecurityAndAnalysis,
): DesiredSecurityAndAnalysis | undefined {
  const changes: Record<string, unknown> = {};

  copyChangedScalar(current, desired, changes, "advancedSecurity");
  copyChangedScalar(current, desired, changes, "codeSecurity");
  copyChangedScalar(current, desired, changes, "secretScanning");
  copyChangedScalar(
    current,
    desired,
    changes,
    "secretScanningPushProtection",
  );
  copyChangedScalar(
    current,
    desired,
    changes,
    "secretScanningAiDetection",
  );

  return Object.keys(changes).length > 0
    ? changes as DesiredSecurityAndAnalysis
    : undefined;
}

function copyChangedScalar(
  current: object,
  desired: object,
  changes: Record<string, unknown>,
  key: string,
): void {
  const currentValue = Reflect.get(current, key);
  const desiredValue = Reflect.get(desired, key);

  if (desiredValue !== undefined && desiredValue !== currentValue) {
    changes[key] = desiredValue;
  }
}

function equalUnorderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();

  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function assertSupportedDesiredState(desired: DesiredState): void {
  const unsupported = [
    ["customProperties", desired.customProperties],
    ["actions", desired.actions],
    ["teams", desired.teams],
    ["secrets", desired.secrets],
    ["variables", desired.variables],
    ["rulesets", desired.rulesets],
    ["environments", desired.environments],
    ["files", desired.files],
  ].filter(([, value]) => value !== undefined)
    .map(([name]) => name);

  if (unsupported.length > 0) {
    throw new Error(
      "Planning is not implemented yet for: " + unsupported.join(", "),
    );
  }
}
