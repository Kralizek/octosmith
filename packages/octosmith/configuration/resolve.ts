import { isAbsolute, relative, resolve } from "@std/path";
import type {
  BuiltInRepositoryPermission,
  PropertyValue,
  RepositoryPermission,
  TeamPermission,
} from "../types.ts";
import type {
  RepositorySelector,
  RepositorySettingsConfiguration,
  RepositoryTemplate,
  Scope,
  RulesetConfiguration,
  RulesetRuleConfiguration,
} from "./types.ts";
import type {
  DesiredMergeSettings,
  DesiredRepositorySettings,
} from "../state/repository.ts";
import type { DesiredActions } from "../state/resources.ts";
import type { DesiredRuleset, DesiredRulesetRule } from "../state/rulesets.ts";
import type {
  DesiredEnvironment,
  DesiredFile,
  DesiredState,
} from "../state/types.ts";
import type { LoadedConfiguration } from "./load.ts";

/** Describes repository metadata. */
export interface RepositoryMetadata {
  readonly name: string;
  readonly teams: readonly string[];
  readonly visibility?: "public" | "private" | "internal";
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

/** Describes runtime value provider. */
export type RuntimeValueProvider = (name: string) => string;

const MAX_CONFIGURATION_SOURCE_SIZE = 10 * 1024 * 1024;
const MAX_CONFIGURATION_SOURCE_TOTAL_SIZE = 50 * 1024 * 1024;

const BUILT_IN_PERMISSIONS = new Set<BuiltInRepositoryPermission>([
  "pull",
  "triage",
  "push",
  "maintain",
  "admin",
]);

const BUILT_IN_PERMISSION_ALIASES: Readonly<
  Record<string, BuiltInRepositoryPermission>
> = {
  read: "pull",
  write: "push",
};

/** Resolve repository configuration into normalized desired state. */
export async function resolveDesiredState(
  loaded: LoadedConfiguration,
  repository: RepositoryMetadata,
  values: RuntimeValueProvider,
): Promise<DesiredState> {
  const matches = Object.entries(loaded.templates)
    .filter(([, template]) =>
      matchesScope(template.match, repository, matchesSelector)
    );

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Repository " + repository.name + " does not match any template"
        : "Repository " + repository.name + " matches multiple templates: " +
          matches.map(([name]) => name).join(", "),
    );
  }

  const [[templateName, template]] = matches;
  const readSource = createConfigurationSourceReader(loaded.root);

  return {
    repository: repository.name,
    template: templateName,
    ...(template.name !== undefined && { templateName: template.name }),
    collections:
      loaded.configuration.repositories.settings?.collectionManagement ??
        "explicit",
    ...(template.repository?.settings && {
      settings: normalizeRepositorySettings(template.repository.settings),
    }),
    ...(template.repository?.teams && {
      teams: template.repository.teams.map(normalizeTeamPermission),
    }),
    ...(template.repository?.customProperties && {
      customProperties: template.repository.customProperties,
    }),
    ...(template.repository.actions && {
      actions: normalizeActions(template.repository.actions, values),
    }),
    ...(template.repository.dependabot && {
      dependabot: {
        ...(template.repository.dependabot.secrets !== undefined && {
          secrets: template.repository.dependabot.secrets.map(normalizeSecret),
        }),
      },
    }),
    ...(template.repository.rulesets && {
      rulesets: template.repository.rulesets.map(normalizeRuleset),
    }),
    ...(template.repository.environments && {
      environments: template.repository.environments.map((environment) =>
        normalizeEnvironment(environment, values)
      ),
    }),
    ...(template.repository.files && {
      files: await Promise.all(
        Object.entries(template.repository.files).map(async ([path, file]) => {
          if (file.ensure === "absent") {
            return { path, ensure: "absent" } satisfies DesiredFile;
          }

          return {
            path,
            ensure: file.ensure,
            content: await readSource(file.source),
          } satisfies DesiredFile;
        }),
      ),
    }),
  };
}

function createConfigurationSourceReader(
  root: string,
): (source: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  let totalSize = 0;

  return async (source: string): Promise<string> => {
    if (isAbsolute(source)) {
      throw new Error(
        "File source must be relative to the configuration root: " + source,
      );
    }

    const rootPath = await Deno.realPath(root);
    const sourcePath = await Deno.realPath(resolve(rootPath, source));
    const relativePath = relative(rootPath, sourcePath);

    if (
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.startsWith("..\\") ||
      isAbsolute(relativePath)
    ) {
      throw new Error("File source escapes the configuration root: " + source);
    }

    const existing = cache.get(sourcePath);
    if (existing !== undefined) {
      return await existing;
    }

    const pending = (async () => {
      const info = await Deno.stat(sourcePath);
      if (!info.isFile) {
        throw new Error("File source must be a regular file: " + source);
      }

      if (info.size > MAX_CONFIGURATION_SOURCE_SIZE) {
        throw new Error(
          "File source exceeds the maximum size of " +
            MAX_CONFIGURATION_SOURCE_SIZE +
            " bytes: " +
            source,
        );
      }

      totalSize += info.size;
      if (totalSize > MAX_CONFIGURATION_SOURCE_TOTAL_SIZE) {
        throw new Error(
          "Configuration file sources exceed the aggregate limit of " +
            MAX_CONFIGURATION_SOURCE_TOTAL_SIZE +
            " bytes",
        );
      }

      return await Deno.readTextFile(sourcePath);
    })();

    cache.set(sourcePath, pending);

    try {
      return await pending;
    } catch (error) {
      cache.delete(sourcePath);
      throw error;
    }
  };
}

/** Determine whether a value matches an include/exclude scope. */
export function matchesScope<TSelector, TValue>(
  scope: Scope<TSelector>,
  value: TValue,
  matches: (selector: TSelector, value: TValue) => boolean,
): boolean {
  return matches(scope.include, value) &&
    (scope.exclude === undefined || !matches(scope.exclude, value));
}

/** Determine whether repository metadata matches a configured selector. */
export function matchesSelector(
  selector: RepositorySelector,
  repository: RepositoryMetadata,
): boolean {
  if (
    selector.names &&
    !selector.names.some((pattern) => matchesGlob(pattern, repository.name))
  ) {
    return false;
  }

  if (
    selector.teams &&
    !selector.teams.every((team) => repository.teams.includes(team))
  ) {
    return false;
  }

  if (selector.visibility) {
    const allowed = Array.isArray(selector.visibility)
      ? selector.visibility
      : [selector.visibility];

    if (!repository.visibility || !allowed.includes(repository.visibility)) {
      return false;
    }
  }

  if (
    selector.properties &&
    !Object.entries(selector.properties).every(([name, expected]) =>
      equalPropertyValue(repository.properties[name], expected)
    )
  ) {
    return false;
  }

  return true;
}

function matchesGlob(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^$\{\}()|[\]\\]/g, (character) => "\\" + character)
    .replaceAll("*", ".*")
    .replaceAll("?", ".");

  return new RegExp("^" + expression + "$").test(value);
}

function equalPropertyValue(
  actual: PropertyValue | undefined,
  expected: PropertyValue,
): boolean {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]);
  }

  return actual === expected;
}

function normalizeRepositorySettings(
  settings: RepositorySettingsConfiguration,
): DesiredRepositorySettings {
  const merge = normalizeMerge(settings);

  return {
    ...(settings.description !== undefined && {
      description: settings.description,
    }),
    ...(settings.website !== undefined && { website: settings.website }),
    ...(settings.topics !== undefined && { topics: settings.topics }),
    ...(settings.visibility !== undefined && {
      visibility: settings.visibility,
    }),
    ...(settings.hasWiki !== undefined && { hasWiki: settings.hasWiki }),
    ...(settings.hasIssues !== undefined && { hasIssues: settings.hasIssues }),
    ...(settings.hasProjects !== undefined && {
      hasProjects: settings.hasProjects,
    }),
    ...(settings.hasDiscussions !== undefined && {
      hasDiscussions: settings.hasDiscussions,
    }),
    ...(settings.hasPullRequests !== undefined && {
      hasPullRequests: settings.hasPullRequests,
    }),
    ...(settings.pullRequestCreationPolicy !== undefined && {
      pullRequestCreationPolicy:
        settings.pullRequestCreationPolicy === "collaborators_only"
          ? "collaborators-only" as const
          : "all" as const,
    }),
    ...(settings.isTemplate !== undefined && {
      isTemplate: settings.isTemplate,
    }),
    ...(settings.defaultBranch !== undefined && {
      defaultBranch: settings.defaultBranch,
    }),
    ...(merge && { merge }),
    ...(settings.archived !== undefined && { archived: settings.archived }),
    ...(settings.allowForking !== undefined && {
      allowForking: settings.allowForking,
    }),
    ...(settings.webCommitSignoffRequired !== undefined && {
      webCommitSignoffRequired: settings.webCommitSignoffRequired,
    }),
    ...(settings.securityAndAnalysis && {
      securityAndAnalysis: { ...settings.securityAndAnalysis },
    }),
  };
}

function normalizeMerge(
  settings: RepositorySettingsConfiguration,
): DesiredMergeSettings | undefined {
  const configured = settings.merge;

  if (!configured && settings.deleteBranchOnMerge === undefined) {
    return undefined;
  }

  return {
    ...(configured?.squash !== undefined && {
      allowSquashMerge: configured.squash,
    }),
    ...(configured?.mergeCommit !== undefined && {
      allowMergeCommit: configured.mergeCommit,
    }),
    ...(configured?.rebase !== undefined && {
      allowRebaseMerge: configured.rebase,
    }),
    ...(configured?.autoMerge !== undefined && {
      allowAutoMerge: configured.autoMerge,
    }),
    ...(configured?.updateBranch !== undefined && {
      allowUpdateBranch: configured.updateBranch,
    }),
    ...(settings.deleteBranchOnMerge !== undefined && {
      deleteBranchOnMerge: settings.deleteBranchOnMerge,
    }),
    ...(configured?.squashCommitTitle !== undefined && {
      squashMergeCommitTitle: configured.squashCommitTitle,
    }),
    ...(configured?.squashCommitMessage !== undefined && {
      squashMergeCommitMessage: configured.squashCommitMessage,
    }),
    ...(configured?.mergeCommitTitle !== undefined && {
      mergeCommitTitle: configured.mergeCommitTitle,
    }),
    ...(configured?.mergeCommitMessage !== undefined && {
      mergeCommitMessage: configured.mergeCommitMessage,
    }),
  };
}

function normalizeActions(
  actions: RepositoryTemplate["repository"] extends infer Repository
    ? Repository extends { readonly actions?: infer Actions }
      ? NonNullable<Actions>
    : never
    : never,
  values: RuntimeValueProvider,
): DesiredActions {
  return {
    ...(actions.secrets !== undefined && {
      secrets: actions.secrets.map(normalizeSecret),
    }),
    ...(actions.variables !== undefined && {
      variables: actions.variables.map((variable) =>
        normalizeVariable(variable, values)
      ),
    }),
    ...(actions.enabled !== undefined && { enabled: actions.enabled }),
    ...(actions.allowedActions !== undefined && {
      allowedActions: actions.allowedActions === "local_only"
        ? "local-only" as const
        : actions.allowedActions,
    }),
    ...(actions.shaPinningRequired !== undefined && {
      shaPinningRequired: actions.shaPinningRequired,
    }),
    ...(actions.selectedActions !== undefined && {
      selectedActions: { ...actions.selectedActions },
    }),
    ...(actions.oidc !== undefined && {
      oidc: {
        ...(actions.oidc.subjectClaimTemplate !== undefined && {
          subjectClaimTemplate: actions.oidc.subjectClaimTemplate,
        }),
        ...(actions.oidc.immutableSubject !== undefined && {
          immutableSubject: actions.oidc.immutableSubject,
        }),
      },
    }),
  };
}

function normalizeTeamPermission(
  permission: { readonly name: string; readonly permission: string },
): TeamPermission {
  return {
    team: permission.name,
    permission: normalizePermission(permission.permission),
  };
}

function normalizePermission(name: string): RepositoryPermission {
  const builtIn = Object.hasOwn(BUILT_IN_PERMISSION_ALIASES, name)
    ? BUILT_IN_PERMISSION_ALIASES[name]
    : (BUILT_IN_PERMISSIONS.has(name as BuiltInRepositoryPermission)
      ? name as BuiltInRepositoryPermission
      : undefined);

  return builtIn === undefined
    ? { kind: "custom", name }
    : { kind: "built-in", name: builtIn };
}

function normalizeRuleset(ruleset: RulesetConfiguration): DesiredRuleset {
  return {
    name: ruleset.name,
    ...(ruleset.target !== undefined && { target: ruleset.target }),
    ...(ruleset.enforcement !== undefined && {
      enforcement: ruleset.enforcement,
    }),
    ...(ruleset.bypassActors !== undefined && {
      bypassActors: ruleset.bypassActors,
    }),
    ...(ruleset.conditions?.refName !== undefined && {
      conditions: {
        refName: {
          ...(ruleset.conditions.refName.include !== undefined && {
            include: ruleset.conditions.refName.include,
          }),
          ...(ruleset.conditions.refName.exclude !== undefined && {
            exclude: ruleset.conditions.refName.exclude,
          }),
        },
      },
    }),
    ...(ruleset.rules !== undefined && {
      rules: ruleset.rules.map(normalizeRule),
    }),
  };
}

function normalizeRule(rule: RulesetRuleConfiguration): DesiredRulesetRule {
  return {
    type: rule.type.replaceAll("_", "-"),
    ...camelizeRuleParameters(rule.parameters ?? {}),
  } as DesiredRulesetRule;
}

function camelizeRuleParameters(
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => [
      name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function normalizeEnvironment(
  environment: NonNullable<
    RepositoryTemplate["repository"]["environments"]
  >[number],
  values: RuntimeValueProvider,
): DesiredEnvironment {
  return {
    name: environment.name,
    ...(environment.secrets !== undefined && {
      secrets: environment.secrets.map(normalizeSecret),
    }),
    ...(environment.variables !== undefined && {
      variables: environment.variables.map((variable) =>
        normalizeVariable(variable, values)
      ),
    }),
  };
}

function normalizeSecret(
  secret: string | { readonly from: string; readonly to: string },
) {
  return typeof secret === "string"
    ? { name: secret, source: secret }
    : { name: secret.to, source: secret.from };
}

function normalizeVariable(
  variable:
    | string
    | { readonly from: string; readonly to: string }
    | { readonly name: string; readonly value: string },
  values: RuntimeValueProvider,
) {
  if (typeof variable === "string") {
    return { name: variable, value: values(variable) };
  }

  if ("from" in variable) {
    return { name: variable.to, value: values(variable.from) };
  }

  return { name: variable.name, value: variable.value };
}
