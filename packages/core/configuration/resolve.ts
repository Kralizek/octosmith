import { isAbsolute, join } from "@std/path";
import type {
  BuiltInRepositoryPermission,
  Environment,
  PropertyValue,
  RepositoryPermission,
  TeamPermission,
} from "../types.ts";
import type {
  RepositorySettingsConfiguration,
  RepositoryTemplate,
  RulesetConfiguration,
  RulesetRuleConfiguration,
} from "./types.ts";
import type {
  DesiredMergeSettings,
  DesiredRepositorySettings,
} from "../state/repository.ts";
import type { DesiredRuleset, DesiredRulesetRule } from "../state/rulesets.ts";
import type { DesiredFile, DesiredState } from "../state/types.ts";
import type { LoadedConfiguration } from "./load.ts";

export interface RepositoryMetadata {
  readonly name: string;
  readonly teams: readonly string[];
  readonly visibility?: "public" | "private" | "internal";
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

export type RuntimeValueProvider = (name: string) => string;

const BUILT_IN_PERMISSIONS = new Set<BuiltInRepositoryPermission>([
  "pull",
  "triage",
  "push",
  "maintain",
  "admin",
]);

export async function resolveDesiredState(
  loaded: LoadedConfiguration,
  repository: RepositoryMetadata,
  values: RuntimeValueProvider,
): Promise<DesiredState> {
  const matches = Object.entries(loaded.templates)
    .filter(([, template]) => matchesSelector(template.match, repository));

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Repository " + repository.name + " does not match any template"
        : "Repository " + repository.name + " matches multiple templates: " +
          matches.map(([name]) => name).join(", "),
    );
  }

  const [[templateName, template]] = matches;

  return {
    repository: repository.name,
    template: templateName,
    ...(template.repository?.settings && {
      settings: normalizeRepositorySettings(template.repository.settings),
    }),
    ...(template.repository?.teams && {
      teams: template.repository.teams.map(normalizeTeamPermission),
    }),
    ...(template.repository?.secrets && {
      secrets: template.repository.secrets,
    }),
    ...(template.repository?.variables && {
      variables: template.repository.variables.map((name) => ({
        name,
        value: values(name),
      })),
    }),
    ...(template.repository?.customProperties && {
      customProperties: template.repository.customProperties,
    }),
    ...(template.rulesets && {
      rulesets: template.rulesets.map(normalizeRuleset),
    }),
    ...(template.environments && {
      environments: template.environments.map((environment) =>
        normalizeEnvironment(environment, values)
      ),
    }),
    ...(template.files && {
      files: await Promise.all(
        Object.entries(template.files).map(async ([path, file]) => {
          if (file.ensure === "absent") {
            return { path, ensure: "absent" } satisfies DesiredFile;
          }

          const source = isAbsolute(file.source)
            ? file.source
            : join(loaded.root, file.source);

          return {
            path,
            ensure: file.ensure,
            content: await Deno.readTextFile(source),
          } satisfies DesiredFile;
        }),
      ),
    }),
  };
}

export function matchesSelector(
  selector: RepositoryTemplate["match"],
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
    .replaceAll(".", "\\.")
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

function normalizeTeamPermission(
  permission: { readonly name: string; readonly permission: string },
): TeamPermission {
  return {
    team: permission.name,
    permission: normalizePermission(permission.permission),
  };
}

function normalizePermission(name: string): RepositoryPermission {
  return BUILT_IN_PERMISSIONS.has(name as BuiltInRepositoryPermission)
    ? { kind: "built-in", name: name as BuiltInRepositoryPermission }
    : { kind: "custom", name };
}

function normalizeRuleset(ruleset: RulesetConfiguration): DesiredRuleset {
  return {
    name: ruleset.name,
    ...(ruleset.target !== undefined && { target: ruleset.target }),
    ...(ruleset.enforcement !== undefined && {
      enforcement: ruleset.enforcement,
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
  environment: {
    readonly name: string;
    readonly secrets?: readonly string[];
    readonly variables?: readonly string[];
  },
  values: RuntimeValueProvider,
): Environment {
  return {
    name: environment.name,
    secrets: environment.secrets ?? [],
    variables: (environment.variables ?? []).map((name) => ({
      name,
      value: values(name),
    })),
  };
}
