import { Ajv2020 } from "ajv/2020";
import type { CurrentState, Operation } from "../mod.ts";
import planSchema from "./plan.schema.json" with { type: "json" };

const validateExecutableRulesetChanges = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
}).compile({
  $defs: planSchema.$defs,
  $ref: "#/$defs/desiredRuleset",
});

/** Runtime and remote-state dependencies consumed while replaying stored operations. */
export interface PersistedOperationContract {
  readonly secretSources: readonly string[];
  readonly state: Readonly<Record<string, unknown>>;
}

/**
 * Describe every apply-time dependency of the exact stored operations.
 *
 * Keep this switch exhaustive so new operation types must declare whether they
 * depend on runtime values or live remote state before persisted replay.
 */
export function persistedOperationContract(
  current: CurrentState,
  operations: readonly Operation[],
): PersistedOperationContract {
  const actions: Record<string, unknown> = {};
  const rulesets: Record<string, unknown>[] = [];
  const environments: Record<string, unknown>[] = [];
  const files: Record<string, unknown>[] = [];
  let needsDefaultBranch = false;

  const rulesetsById = new Map(current.rulesets.map((item) => [item.id, item]));
  const rulesetsByName = new Map(
    current.rulesets.map((item) => [item.name, item]),
  );
  const environmentsByName = new Map(
    current.environments.map((item) => [item.name, item]),
  );
  const filesByPath = new Map(current.files.map((item) => [item.path, item]));

  for (const operation of operations) {
    switch (operation.type) {
      case "update-repository-settings":
      case "set-custom-property":
      case "set-team-permission":
      case "remove-team-permission":
      case "set-actions-variable":
      case "remove-actions-variable":
      case "remove-actions-secret":
      case "remove-dependabot-secret":
        break;

      case "update-actions-settings": {
        const settings: Record<string, unknown> = {};

        if (operation.settings.enabled === undefined) {
          settings.enabled = current.actions.enabled;
        }
        if (
          operation.settings.allowedActions === undefined &&
          operation.settings.selectedActions === undefined
        ) {
          settings.allowedActions = current.actions.allowedActions;
        }
        if (operation.settings.shaPinningRequired === undefined) {
          settings.shaPinningRequired = current.actions.shaPinningRequired;
        }

        if (operation.settings.selectedActions !== undefined) {
          const selected = operation.settings.selectedActions;
          const currentSelected = current.actions.selectedActions;
          const selectedReplay: Record<string, unknown> = {};

          if (selected.githubOwnedAllowed === undefined) {
            selectedReplay.githubOwnedAllowed = currentSelected
              ?.githubOwnedAllowed;
          }
          if (selected.verifiedAllowed === undefined) {
            selectedReplay.verifiedAllowed = currentSelected?.verifiedAllowed;
          }
          if (selected.patternsAllowed === undefined) {
            selectedReplay.patternsAllowed =
              currentSelected?.patternsAllowed === undefined
                ? undefined
                : [...currentSelected.patternsAllowed].sort();
          }

          settings.selectedActions = selectedReplay;
        }

        actions.settings = settings;
        break;
      }

      case "update-actions-oidc": {
        const oidc: Record<string, unknown> = {};
        if (operation.settings.subjectClaimTemplate === undefined) {
          oidc.subjectClaimTemplate = current.actions.oidc.subjectClaimTemplate;
        }
        if (operation.settings.immutableSubject === undefined) {
          oidc.immutableSubject = current.actions.oidc.immutableSubject;
        }
        actions.oidc = oidc;
        break;
      }

      case "set-actions-secret":
      case "set-dependabot-secret":
        break;

      case "create-ruleset": {
        const existing = rulesetsByName.get(operation.ruleset.name);
        rulesets.push({
          operation: "create",
          name: operation.ruleset.name,
          exists: existing !== undefined,
          ...(existing !== undefined && { id: existing.id }),
        });
        break;
      }

      case "update-ruleset": {
        const existing = rulesetsById.get(operation.id);
        const dependency: Record<string, unknown> = {
          operation: "update",
          id: operation.id,
          exists: existing !== undefined,
        };

        if (existing !== undefined) {
          const changes = operation.changes;
          const effectiveTarget = changes.target ?? existing.target;

          if (changes.target === undefined) {
            dependency.target = existing.target;
          }
          if (changes.enforcement === undefined) {
            dependency.enforcement = existing.enforcement;
          }
          if (changes.bypassActors === undefined) {
            dependency.bypassActors = existing.bypassActors;
          }
          if (effectiveTarget !== "push") {
            const currentConditions = existing.target === "push"
              ? { refName: { include: [], exclude: [] } }
              : existing.conditions;
            if (changes.conditions === undefined) {
              dependency.conditions = currentConditions;
            } else {
              const preserved = projectPreserved(
                currentConditions,
                changes.conditions,
              );
              if (preserved !== undefined) {
                dependency.conditions = preserved;
              }
            }
          }
          if (changes.rules === undefined) {
            dependency.rules = existing.rules;
          } else {
            dependency.ruleTypes = existing.rules
              .map((rule) => rule.type)
              .sort();
            const preserved = projectPreservedRules(
              existing.rules,
              changes.rules,
            );
            if (preserved.length > 0) {
              dependency.rules = preserved;
            }
          }
        }

        rulesets.push(dependency);
        break;
      }

      case "delete-ruleset": {
        const existing = rulesetsById.get(operation.id);
        rulesets.push({
          operation: "delete",
          id: operation.id,
          exists: existing !== undefined,
          ...(existing !== undefined && {
            name: existing.name,
          }),
        });
        break;
      }

      case "create-environment": {
        const existing = environmentsByName.get(operation.environment.name);
        environments.push({
          operation: "create",
          name: operation.environment.name,
          exists: existing !== undefined,
        });
        break;
      }

      case "update-environment": {
        const existing = environmentsByName.get(operation.environment.name);
        const removesVariables =
          operation.environment.variables !== undefined &&
          (operation.collections === "strict" ||
            operation.environment.variables.length === 0);
        const removesSecrets = operation.environment.secrets !== undefined &&
          (operation.collections === "strict" ||
            operation.environment.secrets.length === 0);

        environments.push({
          operation: "update",
          name: operation.environment.name,
          exists: existing !== undefined,
          ...(existing !== undefined && removesVariables && {
            variables: [...existing.variables]
              .map((item) => item.name)
              .sort(),
          }),
          ...(existing !== undefined && removesSecrets && {
            secrets: [...existing.secrets].sort(),
          }),
        });
        break;
      }

      case "delete-environment": {
        environments.push({
          operation: "delete",
          name: operation.name,
          exists: environmentsByName.has(operation.name),
        });
        break;
      }

      case "create-file": {
        needsDefaultBranch = true;
        files.push({
          operation: "create",
          path: operation.file.path,
          exists: filesByPath.has(operation.file.path),
        });
        break;
      }

      case "update-file": {
        needsDefaultBranch = true;
        const existing = filesByPath.get(operation.file.path);
        files.push({
          operation: "update",
          path: operation.file.path,
          exists: existing !== undefined,
          ...(existing !== undefined && { sha: existing.sha }),
        });
        break;
      }

      case "delete-file": {
        needsDefaultBranch = true;
        const existing = filesByPath.get(operation.path);
        files.push({
          operation: "delete",
          path: operation.path,
          exists: existing !== undefined,
          ...(existing !== undefined && { sha: existing.sha }),
        });
        break;
      }

      default:
        assertNever(operation);
    }
  }

  const state: Record<string, unknown> = {};

  if (Object.keys(actions).length > 0) {
    state.actions = actions;
  }
  if (rulesets.length > 0) {
    state.rulesets = sortBy(
      rulesets,
      (value) => String(Reflect.get(value, "id") ?? Reflect.get(value, "name")),
    );
  }
  if (environments.length > 0) {
    state.environments = sortBy(
      environments,
      (value) => String(Reflect.get(value, "name")),
    );
  }
  if (files.length > 0) {
    state.files = sortBy(files, (value) => String(Reflect.get(value, "path")));
  }
  if (needsDefaultBranch) {
    state.defaultBranch = current.settings.defaultBranch;
    state.filesBranch = current.filesBranch ?? current.settings.defaultBranch;
  }

  return {
    secretSources: persistedOperationSecretSources(operations),
    state,
  };
}

/** Resolve the branch consumed by the stored, batched file operations. */
export function fileExecutionBranch(
  defaultBranch: string,
  operations: readonly Operation[],
): string {
  let branch = defaultBranch;
  let filesBranch: string | undefined;
  for (const operation of operations) {
    if (operation.type === "update-repository-settings") {
      branch = operation.settings.defaultBranch ?? branch;
    } else if (
      operation.type === "create-file" || operation.type === "update-file" ||
      operation.type === "delete-file"
    ) {
      if (filesBranch !== undefined && filesBranch !== branch) {
        throw new Error(
          "Managed file operations must use one execution branch",
        );
      }
      filesBranch = branch;
    }
  }
  return filesBranch ?? branch;
}

/** Validate semantic invariants required for safe exact replay. */
export function assertPersistedOperationsExecutable(
  operations: readonly Operation[],
): void {
  for (const operation of operations) {
    switch (operation.type) {
      case "update-repository-settings":
      case "update-actions-settings":
      case "update-actions-oidc":
        break;

      case "set-custom-property":
        requireNonEmpty(operation.name, "custom property name");
        break;

      case "set-team-permission":
        requireNonEmpty(operation.permission.team, "team name");
        requireNonEmpty(
          operation.permission.permission.name,
          "team permission name",
        );
        break;

      case "remove-team-permission":
        requireNonEmpty(operation.team, "team name");
        break;

      case "set-actions-variable":
        requireNonEmpty(operation.variable.name, "Actions variable name");
        break;

      case "remove-actions-variable":
        requireNonEmpty(operation.name, "Actions variable name");
        break;

      case "set-actions-secret":
      case "set-dependabot-secret":
        requireNonEmpty(operation.secret.name, "secret name");
        requireNonEmpty(operation.secret.source, "secret source");
        break;

      case "remove-actions-secret":
      case "remove-dependabot-secret":
        requireNonEmpty(operation.secret, "secret name");
        break;

      case "create-ruleset":
        requireNonEmpty(operation.ruleset.name, "ruleset name");
        break;

      case "update-ruleset":
        requirePositiveInteger(operation.id, "ruleset id");
        requireNonEmpty(operation.changes.name, "ruleset name");
        if (!validateExecutableRulesetChanges(operation.changes)) {
          throw new Error(
            "Invalid executable ruleset update: " +
              validateExecutableRulesetChanges.errors?.map((error) =>
                (error.instancePath || "/") + " " + error.message
              ).join("; "),
          );
        }
        break;

      case "delete-ruleset":
        requirePositiveInteger(operation.id, "ruleset id");
        requireNonEmpty(operation.name, "ruleset name");
        break;

      case "create-environment":
      case "update-environment":
        requireNonEmpty(operation.environment.name, "environment name");
        for (const variable of operation.environment.variables ?? []) {
          requireNonEmpty(variable.name, "environment variable name");
        }
        for (const secret of operation.environment.secrets ?? []) {
          requireNonEmpty(secret.name, "environment secret name");
          requireNonEmpty(secret.source, "environment secret source");
        }
        break;

      case "delete-environment":
        requireNonEmpty(operation.name, "environment name");
        break;

      case "create-file":
        requireNonEmpty(operation.file.path, "file path");
        break;

      case "update-file":
        requireNonEmpty(operation.file.path, "file path");
        requireNonEmpty(operation.sha, "file sha");
        break;

      case "delete-file":
        requireNonEmpty(operation.path, "file path");
        requireNonEmpty(operation.sha, "file sha");
        break;

      default:
        assertNever(operation);
    }
  }
}

/** Collect runtime secret sources required by exact stored operations. */
export function persistedOperationSecretSources(
  operations: readonly Operation[],
): readonly string[] {
  const sources = new Set<string>();

  for (const operation of operations) {
    switch (operation.type) {
      case "set-actions-secret":
      case "set-dependabot-secret":
        sources.add(operation.secret.source);
        break;

      case "create-environment":
      case "update-environment":
        for (const secret of operation.environment.secrets ?? []) {
          sources.add(secret.source);
        }
        break;

      case "update-repository-settings":
      case "set-custom-property":
      case "update-actions-settings":
      case "update-actions-oidc":
      case "set-team-permission":
      case "remove-team-permission":
      case "set-actions-variable":
      case "remove-actions-variable":
      case "remove-actions-secret":
      case "remove-dependabot-secret":
      case "create-ruleset":
      case "update-ruleset":
      case "delete-ruleset":
      case "delete-environment":
      case "create-file":
      case "update-file":
      case "delete-file":
        break;

      default:
        assertNever(operation);
    }
  }

  return [...sources].sort();
}

function projectPreserved(current: unknown, replay: unknown): unknown {
  if (Object.is(current, replay)) {
    return current;
  }

  if (
    current === null ||
    replay === null ||
    typeof current !== "object" ||
    typeof replay !== "object" ||
    Array.isArray(current) ||
    Array.isArray(replay)
  ) {
    if (
      Array.isArray(current) &&
      Array.isArray(replay) &&
      JSON.stringify(current) === JSON.stringify(replay)
    ) {
      return current;
    }
    return undefined;
  }

  const entries = Object.entries(replay as Record<string, unknown>).flatMap(
    ([key, value]) => {
      if (!Object.hasOwn(current as object, key)) {
        return [];
      }
      const preserved = projectPreserved(
        Reflect.get(current as object, key),
        value,
      );
      return preserved === undefined ? [] : [[key, preserved] as const];
    },
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function projectPreservedRules(
  current: CurrentState["rulesets"][number]["rules"],
  replay: NonNullable<
    Extract<Operation, { readonly type: "update-ruleset" }>["changes"]["rules"]
  >,
): readonly unknown[] {
  const currentByType = new Map(current.map((rule) => [rule.type, rule]));

  return replay.flatMap((rule) => {
    const existing = currentByType.get(rule.type);
    if (existing === undefined) {
      return [];
    }
    return [existing];
  });
}

function requireNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error("Invalid persisted operation: empty " + label);
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Invalid persisted operation: invalid " + label);
  }
}

function sortBy<T extends object>(
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function assertNever(value: never): never {
  throw new Error(
    "Unhandled persisted operation contract: " +
      String(Reflect.get(value as object, "type")),
  );
}
