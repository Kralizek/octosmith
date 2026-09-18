import type {
  Environment,
  RepositoryPermission,
  TeamPermission,
  Variable,
} from "../types.ts";
import type {
  CurrentActionsSettings,
  CustomPropertyValue,
  DesiredActionsOidcSettings,
  DesiredActionsSettings,
} from "../state/resources.ts";
import type {
  CurrentRepositorySettings,
  DesiredMergeSettings,
  DesiredRepositorySettings,
  DesiredSecurityAndAnalysis,
} from "../state/repository.ts";
import type {
  CurrentRefRule,
  CurrentRuleset,
  CurrentPushRule,
  DesiredRuleset,
  DesiredRulesetRule,
  RulesetBypassActor,
  RulesetDefinition,
} from "../state/rulesets.ts";
import type {
  CurrentFile,
  CurrentState,
  DesiredFile,
  DesiredState,
} from "../state/types.ts";
import type { Operation, Plan } from "./types.ts";

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

  const operations: Operation[] = [];

  planRepositorySettings(current, desired, operations);
  planCustomProperties(current, desired, operations);
  planActions(current, desired, operations);
  planTeams(current, desired, operations);
  planRepositorySecrets(current, desired, operations);
  planRepositoryVariables(current, desired, operations);
  planRulesets(current, desired, operations);
  planEnvironments(current, desired, operations);
  planFiles(current, desired, operations);

  return {
    repository: desired.repository,
    operations,
  };
}

function planRepositorySettings(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (!desired.settings) {
    return;
  }

  const changes = diffRepositorySettings(current.settings, desired.settings);

  if (changes) {
    operations.push({
      type: "update-repository-settings",
      settings: changes,
    });
  }
}

function planCustomProperties(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.customProperties === undefined) {
    return;
  }

  for (const [name, value] of Object.entries(desired.customProperties)) {
    if (!equalCustomPropertyValue(current.customProperties[name], value)) {
      operations.push({
        type: "set-custom-property",
        name,
        value,
      });
    }
  }
}

function planActions(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (!desired.actions) {
    return;
  }

  const settings = diffActionsSettings(current.actions, desired.actions);

  if (settings) {
    operations.push({
      type: "update-actions-settings",
      settings,
    });
  }

  if (desired.actions.oidc) {
    const oidc = diffActionsOidc(current.actions.oidc, desired.actions.oidc);

    if (oidc) {
      operations.push({
        type: "update-actions-oidc",
        settings: oidc,
      });
    }
  }
}

function planTeams(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.teams === undefined) {
    return;
  }

  if (desired.teams.length === 0) {
    for (const permission of current.teams) {
      operations.push({
        type: "remove-team-permission",
        team: permission.team,
      });
    }

    return;
  }

  assertUnique(desired.teams.map((item) => item.team), "team");

  const currentByTeam = new Map(current.teams.map((item) => [item.team, item]));

  for (const permission of desired.teams) {
    const actual = currentByTeam.get(permission.team);

    if (!actual || !equalPermission(actual.permission, permission.permission)) {
      operations.push({
        type: "set-team-permission",
        permission,
      });
    }
  }
}

function planRepositorySecrets(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.secrets === undefined) {
    return;
  }

  assertUnique(desired.secrets, "repository secret");

  if (desired.secrets.length === 0) {
    for (const secret of current.secrets) {
      operations.push({
        type: "remove-repository-secret",
        secret,
      });
    }

    return;
  }

  // GitHub exposes secret names but never values, so declared secrets must be
  // written on every reconciliation to guarantee their desired runtime value.
  for (const secret of desired.secrets) {
    operations.push({
      type: "set-repository-secret",
      secret,
    });
  }
}

function planRepositoryVariables(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.variables === undefined) {
    return;
  }

  assertUnique(desired.variables.map((item) => item.name), "repository variable");

  if (desired.variables.length === 0) {
    for (const variable of current.variables) {
      operations.push({
        type: "remove-repository-variable",
        name: variable.name,
      });
    }

    return;
  }

  const currentByName = new Map(
    current.variables.map((item) => [item.name, item]),
  );

  for (const variable of desired.variables) {
    const actual = currentByName.get(variable.name);

    if (!actual || actual.value !== variable.value) {
      operations.push({
        type: "set-repository-variable",
        variable,
      });
    }
  }
}

function planRulesets(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.rulesets === undefined) {
    return;
  }

  if (desired.rulesets.length === 0) {
    for (const ruleset of current.rulesets) {
      operations.push({
        type: "delete-ruleset",
        id: ruleset.id,
        name: ruleset.name,
      });
    }

    return;
  }

  assertUnique(desired.rulesets.map((item) => item.name), "ruleset");

  const currentByName = new Map(
    current.rulesets.map((item) => [item.name, item]),
  );

  for (const ruleset of desired.rulesets) {
    const actual = currentByName.get(ruleset.name);

    if (!actual) {
      operations.push({
        type: "create-ruleset",
        ruleset: materializeRuleset(ruleset),
      });

      continue;
    }

    const changes = diffRuleset(actual, ruleset);

    if (changes) {
      operations.push({
        type: "update-ruleset",
        id: actual.id,
        changes,
      });
    }
  }
}

function planEnvironments(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.environments === undefined) {
    return;
  }

  if (desired.environments.length === 0) {
    for (const environment of current.environments) {
      operations.push({
        type: "delete-environment",
        name: environment.name,
      });
    }

    return;
  }

  assertUnique(desired.environments.map((item) => item.name), "environment");

  const currentByName = new Map(
    current.environments.map((item) => [item.name, item]),
  );

  for (const environment of desired.environments) {
    const actual = currentByName.get(environment.name);

    if (!actual) {
      operations.push({
        type: "create-environment",
        environment,
      });

      continue;
    }

    if (environmentNeedsUpdate(actual, environment)) {
      operations.push({
        type: "update-environment",
        environment,
      });
    }
  }
}

function planFiles(
  current: CurrentState,
  desired: DesiredState,
  operations: Operation[],
): void {
  if (desired.files === undefined) {
    return;
  }

  assertUnique(desired.files.map((item) => item.path), "file");

  const currentByPath = new Map(current.files.map((item) => [item.path, item]));

  for (const file of desired.files) {
    const actual = currentByPath.get(file.path);

    if (file.ensure === "absent") {
      if (actual) {
        operations.push({
          type: "delete-file",
          path: file.path,
          sha: actual.sha,
        });
      }

      continue;
    }

    if (!actual) {
      operations.push({
        type: "create-file",
        file,
      });

      continue;
    }

    if (file.ensure === "exact" && actual.content !== file.content) {
      operations.push({
        type: "update-file",
        sha: actual.sha,
        file,
      });
    }
  }
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

function diffActionsSettings(
  current: CurrentActionsSettings,
  desired: DesiredActionsSettings,
): DesiredActionsSettings | undefined {
  const changes: Record<string, unknown> = {};

  copyChangedScalar(current, desired, changes, "enabled");
  copyChangedScalar(current, desired, changes, "allowedActions");
  copyChangedScalar(current, desired, changes, "shaPinningRequired");

  if (desired.selectedActions) {
    const selectedChanges: Record<string, unknown> = {};
    const actual = current.selectedActions;

    if (
      desired.selectedActions.githubOwnedAllowed !== undefined &&
      desired.selectedActions.githubOwnedAllowed !== actual?.githubOwnedAllowed
    ) {
      selectedChanges.githubOwnedAllowed =
        desired.selectedActions.githubOwnedAllowed;
    }

    if (
      desired.selectedActions.verifiedAllowed !== undefined &&
      desired.selectedActions.verifiedAllowed !== actual?.verifiedAllowed
    ) {
      selectedChanges.verifiedAllowed = desired.selectedActions.verifiedAllowed;
    }

    if (
      desired.selectedActions.patternsAllowed !== undefined &&
      (
        !actual ||
        !equalUnorderedStrings(
          actual.patternsAllowed,
          desired.selectedActions.patternsAllowed,
        )
      )
    ) {
      selectedChanges.patternsAllowed = desired.selectedActions.patternsAllowed;
    }

    if (Object.keys(selectedChanges).length > 0) {
      changes.selectedActions = selectedChanges;
    }
  }

  return Object.keys(changes).length > 0
    ? changes as DesiredActionsSettings
    : undefined;
}

function diffActionsOidc(
  current: CurrentActionsSettings["oidc"],
  desired: DesiredActionsOidcSettings,
): DesiredActionsOidcSettings | undefined {
  const changes: Record<string, unknown> = {};

  if (
    desired.subjectClaimTemplate !== undefined &&
    !deepEqual(current.subjectClaimTemplate, desired.subjectClaimTemplate)
  ) {
    changes.subjectClaimTemplate = desired.subjectClaimTemplate;
  }

  copyChangedScalar(current, desired, changes, "immutableSubject");

  return Object.keys(changes).length > 0
    ? changes as DesiredActionsOidcSettings
    : undefined;
}

function diffRuleset(
  current: CurrentRuleset,
  desired: DesiredRuleset,
): DesiredRuleset | undefined {
  const changes: Record<string, unknown> = {
    name: desired.name,
  };

  copyChangedScalar(current, desired, changes, "target");
  copyChangedScalar(current, desired, changes, "enforcement");

  if (
    desired.bypassActors !== undefined &&
    !deepEqual(current.bypassActors, desired.bypassActors)
  ) {
    changes.bypassActors = desired.bypassActors;
  }

  if (desired.conditions !== undefined) {
    if (current.target === "push") {
      throw new Error(
        "Push ruleset " + desired.name + " cannot declare ref conditions",
      );
    }

    const merged = mergeOwned(current.conditions, desired.conditions);

    if (!deepEqual(current.conditions, merged)) {
      changes.conditions = merged;
    }
  }

  if (desired.rules !== undefined) {
    const merged = mergeRules(current.rules, desired.rules);

    if (!deepEqual(current.rules, merged)) {
      changes.rules = merged;
    }
  }

  return Object.keys(changes).length > 1
    ? changes as DesiredRuleset
    : undefined;
}

function materializeRuleset(desired: DesiredRuleset): RulesetDefinition {
  if (!desired.target) {
    throw new Error(
      "Ruleset " + desired.name + " requires target when it does not exist",
    );
  }

  if (!desired.enforcement) {
    throw new Error(
      "Ruleset " + desired.name +
        " requires enforcement when it does not exist",
    );
  }

  const bypassActors = (desired.bypassActors ?? []) as readonly RulesetBypassActor[];
  const rules = (desired.rules ?? []) as readonly DesiredRulesetRule[];

  if (desired.target === "push") {
    if (desired.conditions !== undefined) {
      throw new Error(
        "Push ruleset " + desired.name + " cannot declare ref conditions",
      );
    }

    return {
      name: desired.name,
      target: "push",
      enforcement: desired.enforcement,
      bypassActors,
      rules: rules as readonly CurrentPushRule[],
    };
  }

  const refName = desired.conditions?.refName;

  if (!refName) {
    throw new Error(
      "Ruleset " + desired.name +
        " requires conditions.refName when it does not exist",
    );
  }

  return {
    name: desired.name,
    target: desired.target,
    enforcement: desired.enforcement,
    bypassActors,
    conditions: {
      refName: {
        include: refName.include ?? [],
        exclude: refName.exclude ?? [],
      },
    },
    rules: rules as readonly CurrentRefRule[],
  };
}

function mergeRules(
  current: readonly (CurrentRefRule | CurrentPushRule)[],
  desired: readonly DesiredRulesetRule[],
): readonly DesiredRulesetRule[] {
  if (desired.length === 0) {
    return [];
  }

  assertUnique(desired.map((rule) => rule.type), "ruleset rule type");

  const result = current.map((rule) => structuredClone(rule)) as unknown[];
  const indexByType = new Map(
    current.map((rule, index) => [rule.type, index]),
  );

  for (const rule of desired) {
    const index = indexByType.get(rule.type);

    if (index === undefined) {
      result.push(structuredClone(rule));
      continue;
    }

    result[index] = mergeOwned(result[index], rule);
  }

  return result as readonly DesiredRulesetRule[];
}

function environmentNeedsUpdate(
  current: Environment,
  desired: Environment,
): boolean {
  if (desired.secrets.length > 0) {
    return true;
  }

  if (!equalUnorderedStrings(current.secrets, desired.secrets)) {
    return true;
  }

  return !equalVariables(current.variables, desired.variables);
}

function equalVariables(
  left: readonly Variable[],
  right: readonly Variable[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftByName = new Map(left.map((item) => [item.name, item.value]));

  return right.every((item) => leftByName.get(item.name) === item.value);
}

function equalPermission(
  left: RepositoryPermission,
  right: RepositoryPermission,
): boolean {
  return left.kind === right.kind && left.name === right.name;
}

function equalCustomPropertyValue(
  left: CustomPropertyValue | undefined,
  right: CustomPropertyValue,
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return equalUnorderedStrings(left, right);
  }

  return left === right;
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

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function mergeOwned(current: unknown, desired: unknown): unknown {
  if (Array.isArray(desired)) {
    return structuredClone(desired);
  }

  if (
    desired === null ||
    typeof desired !== "object" ||
    current === null ||
    typeof current !== "object" ||
    Array.isArray(current)
  ) {
    return structuredClone(desired);
  }

  const result = structuredClone(current) as Record<string, unknown>;

  for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
    result[key] = value === undefined
      ? result[key]
      : mergeOwned(result[key], value);
  }

  return result;
}

function assertUnique(values: readonly string[], resource: string): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new Error("Duplicate " + resource + ": " + value);
    }

    seen.add(value);
  }
}
