import type {
  CurrentRuleset,
  CurrentState,
  DesiredRuleset,
  DesiredRulesetRule,
  DesiredState,
  Operation,
} from "../mod.ts";
import { persistedOperationContract } from "./operation_contract.ts";

/**
 * Semantic current state relevant to planning plus exact replay dependencies.
 *
 * Template-owned planning state and persisted-operation replay dependencies are
 * projected independently so apply-time reads cannot silently drift from the
 * state precondition.
 */
export type OwnedCurrentState = Readonly<Record<string, unknown>>;

/** Project current state to planner-owned state plus exact replay dependencies. */
export function projectOwnedCurrentState(
  current: CurrentState,
  desired: DesiredState,
  operations: readonly Operation[] = [],
): OwnedCurrentState {
  const strict = desired.collections === "strict";
  const projected: Record<string, unknown> = {
    repository: current.repository,
  };

  if (desired.settings !== undefined) {
    const settings = projectShape(
      current.settings,
      desired.settings,
    ) as Record<string, unknown>;

    if (desired.settings.topics !== undefined) {
      settings.topics = [...current.settings.topics].sort();
    }

    projected.settings = settings;
  }

  if (desired.customProperties !== undefined) {
    const owned = Object.fromEntries(
      Object.keys(desired.customProperties).sort().map((name) => {
        const present = Object.hasOwn(current.customProperties, name);
        const value = current.customProperties[name];

        return [
          name,
          {
            present,
            ...(present && {
              value: Array.isArray(value) ? [...value].sort() : value,
            }),
          },
        ];
      }),
    );
    const strictUnowned = strict
      ? Object.entries(current.customProperties)
        .filter(([name, value]) =>
          !(name in desired.customProperties!) && value !== null
        )
        .map(([name]) => name)
        .sort()
      : [];

    projected.customProperties = {
      owned,
      ...(strict && { strictUnowned }),
    };
  }

  if (desired.actions !== undefined) {
    const actions: Record<string, unknown> = {};

    for (
      const key of [
        "enabled",
        "allowedActions",
        "shaPinningRequired",
        "selectedActions",
      ] as const
    ) {
      if (desired.actions[key] !== undefined) {
        actions[key] = projectShape(
          Reflect.get(current.actions, key),
          Reflect.get(desired.actions, key),
        );
      }
    }

    if (desired.actions.selectedActions !== undefined) {
      if (
        desired.actions.selectedActions.patternsAllowed !== undefined &&
        current.actions.selectedActions !== undefined
      ) {
        const selected = actions.selectedActions as Record<string, unknown>;
        selected.patternsAllowed = [
          ...current.actions.selectedActions.patternsAllowed,
        ].sort();
      }

      if (desired.actions.allowedActions === undefined) {
        actions.allowedActions = current.actions.allowedActions;
      }
    }

    if (desired.actions.oidc !== undefined) {
      actions.oidc = projectShape(current.actions.oidc, desired.actions.oidc);
    }

    if (desired.actions.secrets !== undefined && strict) {
      actions.secrets = [...current.actions.secrets].sort();
    }

    if (desired.actions.variables !== undefined) {
      actions.variables = projectNamedCollection(
        current.actions.variables,
        desired.actions.variables,
        "name",
        strict,
      );
    }

    projected.actions = actions;
  }

  if (desired.dependabot?.secrets !== undefined && strict) {
    projected.dependabot = {
      secrets: [...current.dependabot.secrets].sort(),
    };
  }

  if (desired.teams !== undefined) {
    projected.teams = projectNamedCollection(
      current.teams,
      desired.teams,
      "team",
      strict,
    );
  }

  if (desired.rulesets !== undefined) {
    projected.rulesets = projectRulesets(
      current.rulesets,
      desired.rulesets,
      strict,
    );
  }

  if (desired.environments !== undefined) {
    projected.environments = projectEnvironments(
      current.environments,
      desired.environments,
      strict,
    );
  }

  if (desired.files !== undefined) {
    projected.files = projectFiles(current.files, desired.files);
  }

  const replay = persistedOperationContract(current, operations).state;
  if (Object.keys(replay).length > 0) {
    projected.replay = replay;
  }

  return projected;
}

function projectShape(current: unknown, desired: unknown): unknown {
  if (Array.isArray(desired)) {
    return current;
  }

  if (
    desired === null ||
    typeof desired !== "object" ||
    current === null ||
    typeof current !== "object" ||
    Array.isArray(current)
  ) {
    return current;
  }

  return Object.fromEntries(
    Object.entries(desired as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        projectShape(Reflect.get(current, key), value),
      ]),
  );
}

function projectNamedCollection<
  Current extends object,
  Desired extends object,
>(
  current: readonly Current[],
  desired: readonly Desired[],
  identity: string,
  strict: boolean,
): readonly unknown[] {
  const desiredByName = new Map(
    desired.map((item) => [String(Reflect.get(item, identity)), item]),
  );

  return current.flatMap((item) => {
    const name = String(Reflect.get(item, identity));
    const owned = desiredByName.get(name);

    if (owned === undefined) {
      return strict ? [{ [identity]: name }] : [];
    }

    return [{
      [identity]: name,
      ...projectShape(item, owned) as Record<string, unknown>,
    }];
  }).sort((left, right) =>
    String(Reflect.get(left, identity)).localeCompare(
      String(Reflect.get(right, identity)),
    )
  );
}

function projectRulesets(
  current: readonly CurrentRuleset[],
  desired: readonly DesiredRuleset[],
  strict: boolean,
): readonly unknown[] {
  const desiredByName = new Map(desired.map((item) => [item.name, item]));

  return current.flatMap((ruleset) => {
    const owned = desiredByName.get(ruleset.name);

    if (owned === undefined) {
      return strict ? [{ name: ruleset.name }] : [];
    }

    const result: Record<string, unknown> = {
      name: ruleset.name,
      ...projectShape(ruleset, owned) as Record<string, unknown>,
    };

    if (owned.rules !== undefined) {
      result.rules = projectRules(ruleset.rules, owned.rules, strict);
    }

    return [result];
  }).sort((left, right) =>
    String(Reflect.get(left, "name")).localeCompare(
      String(Reflect.get(right, "name")),
    )
  );
}

function projectRules(
  current: CurrentRuleset["rules"],
  desired: readonly DesiredRulesetRule[],
  strict: boolean,
): readonly unknown[] {
  const desiredByType = new Map(desired.map((rule) => [rule.type, rule]));

  return current.flatMap((rule) => {
    const owned = desiredByType.get(rule.type);

    if (owned === undefined) {
      return strict ? [rule] : [];
    }

    return [{
      type: rule.type,
      ...projectShape(rule, owned) as Record<string, unknown>,
    }];
  }).sort((left, right) =>
    String(Reflect.get(left, "type")).localeCompare(
      String(Reflect.get(right, "type")),
    )
  );
}

function projectEnvironments(
  current: CurrentState["environments"],
  desired: NonNullable<DesiredState["environments"]>,
  strict: boolean,
): readonly unknown[] {
  const desiredByName = new Map(desired.map((item) => [item.name, item]));

  return current.flatMap((environment) => {
    const owned = desiredByName.get(environment.name);

    if (owned === undefined) {
      return strict ? [{ name: environment.name }] : [];
    }

    return [{
      name: environment.name,
      ...(owned.secrets !== undefined &&
        (strict || owned.secrets.length === 0) && {
        secrets: [...environment.secrets].sort(),
      }),
      ...(owned.variables !== undefined && {
        variables: projectNamedCollection(
          environment.variables,
          owned.variables,
          "name",
          strict || owned.variables.length === 0,
        ),
      }),
    }];
  }).sort((left, right) =>
    String(Reflect.get(left, "name")).localeCompare(
      String(Reflect.get(right, "name")),
    )
  );
}

function projectFiles(
  current: CurrentState["files"],
  desired: NonNullable<DesiredState["files"]>,
): readonly unknown[] {
  const currentByPath = new Map(current.map((file) => [file.path, file]));

  return desired.map((file) => {
    const actual = currentByPath.get(file.path);

    if (actual === undefined) {
      return { path: file.path, exists: false };
    }

    if (file.ensure === "exists") {
      return { path: file.path, exists: true };
    }

    if (file.ensure === "absent") {
      return { path: file.path, exists: true };
    }

    return {
      path: file.path,
      exists: true,
      content: actual.content,
    };
  }).sort((left, right) =>
    String(Reflect.get(left, "path")).localeCompare(
      String(Reflect.get(right, "path")),
    )
  );
}
