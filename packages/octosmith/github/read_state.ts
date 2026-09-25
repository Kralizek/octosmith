import {
  type CurrentState,
  type DesiredState,
  fileExecutionBranch,
  type Operation,
} from "../mod.ts";
import type { RepositoryStateSource } from "./state_source.ts";

/** Read the current GitHub state needed for the supplied desired state. */
export async function readCurrentState(
  source: RepositoryStateSource,
  desired: DesiredState,
  operations?: readonly Operation[],
): Promise<CurrentState> {
  const repository = desired.repository;
  const strict = desired.collections === "strict";

  const [
    settings,
    customProperties,
    actionsSettings,
    actionsOidc,
    actionsSecrets,
    actionsVariables,
    dependabotSecrets,
    teams,
    rulesets,
    environments,
  ] = await Promise.all([
    source.getRepositorySettings(repository),
    desired.customProperties !== undefined
      ? source.getCustomProperties(repository)
      : Promise.resolve({}),
    desired.actions !== undefined &&
      hasActionsPermissionSettings(desired.actions)
      ? source.getActionsSettings(repository)
      : defaultActionsPermissionSettings(),
    desired.actions?.oidc !== undefined
      ? source.getActionsOidcSettings(repository)
      : defaultActionsOidcSettings(),
    desired.actions?.secrets !== undefined
      ? source.getActionsSecrets(repository)
      : Promise.resolve([]),
    desired.actions?.variables !== undefined
      ? source.getActionsVariables(repository)
      : Promise.resolve([]),
    desired.dependabot?.secrets !== undefined
      ? source.getDependabotSecrets(repository)
      : Promise.resolve([]),
    desired.teams !== undefined
      ? source.getTeams(repository)
      : Promise.resolve([]),
    desired.rulesets !== undefined
      ? source.getRulesets(repository)
      : Promise.resolve([]),
    desired.environments !== undefined
      ? source.getEnvironments(repository)
      : Promise.resolve([]),
  ]);

  const filesBranch = operations === undefined
    ? desired.settings?.defaultBranch ?? settings.defaultBranch
    : fileExecutionBranch(settings.defaultBranch, operations);
  const paths = [
    ...new Set([
      ...(desired.files ?? []).map((file) => file.path),
      ...(operations ?? []).flatMap((operation) => {
        switch (operation.type) {
          case "create-file":
          case "update-file":
            return [operation.file.path];
          case "delete-file":
            return [operation.path];
          default:
            return [];
        }
      }),
    ]),
  ];
  const files = await readOwnedFiles(source, repository, paths, filesBranch);

  return {
    repository,
    settings,
    customProperties: desired.customProperties === undefined
      ? {}
      : strict
      ? customProperties
      : pickKeys(customProperties, Object.keys(desired.customProperties)),
    actions: {
      ...actionsSettings,
      oidc: actionsOidc,
      secrets: desired.actions?.secrets === undefined
        ? []
        : strict
        ? actionsSecrets
        : actionsSecrets.filter((name) =>
          desired.actions?.secrets?.some((secret) => secret.name === name)
        ),
      variables: desired.actions?.variables === undefined
        ? []
        : strict
        ? actionsVariables
        : filterNamed(
          actionsVariables,
          desired.actions.variables.map((item) => item.name),
          "name",
        ),
    },
    dependabot: {
      secrets: desired.dependabot?.secrets === undefined
        ? []
        : strict
        ? dependabotSecrets
        : dependabotSecrets.filter((name) =>
          desired.dependabot?.secrets?.some((secret) => secret.name === name)
        ),
    },
    teams: desired.teams === undefined
      ? []
      : strict
      ? teams
      : filterNamed(teams, desired.teams.map((item) => item.team), "team"),
    rulesets: desired.rulesets === undefined
      ? []
      : strict
      ? rulesets
      : filterNamed(
        rulesets,
        desired.rulesets.map((item) => item.name),
        "name",
      ),
    environments: desired.environments === undefined
      ? []
      : strict
      ? environments
      : filterSparseEnvironments(environments, desired.environments),
    ...(paths.length > 0 && { filesBranch }),
    files,
  };
}

function filterSparseEnvironments(
  environments: CurrentState["environments"],
  desired: NonNullable<DesiredState["environments"]>,
): CurrentState["environments"] {
  const desiredByName = new Map(desired.map((item) => [item.name, item]));

  return environments.flatMap((environment) => {
    const owned = desiredByName.get(environment.name);

    if (!owned) {
      return [];
    }

    return [{
      ...environment,
      secrets: owned.secrets === undefined
        ? []
        : owned.secrets.length === 0
        ? environment.secrets
        : environment.secrets.filter((name) =>
          owned.secrets?.some((secret) => secret.name === name)
        ),
      variables: owned.variables === undefined
        ? []
        : owned.variables.length === 0
        ? environment.variables
        : filterNamed(
          environment.variables,
          owned.variables.map((item) => item.name),
          "name",
        ),
    }];
  });
}

async function readOwnedFiles(
  source: RepositoryStateSource,
  repository: string,
  paths: readonly string[],
  branch: string,
): Promise<CurrentState["files"]> {
  if (paths.length === 0) {
    return [];
  }

  await source.getBranchHead(repository, branch);
  const files = await Promise.all(
    paths.map((path) => source.getFile(repository, path, branch)),
  );

  return files.filter((file): file is NonNullable<typeof file> =>
    file !== undefined
  );
}

function pickKeys<T>(
  values: Readonly<Record<string, T>>,
  names: readonly string[],
): Readonly<Record<string, T>> {
  const wanted = new Set(names);

  return Object.fromEntries(
    Object.entries(values).filter(([name]) => wanted.has(name)),
  );
}

function filterNamed<T extends object>(
  values: readonly T[],
  names: readonly string[],
  field: string,
): readonly T[] {
  const wanted = new Set(names);

  return values.filter((value) =>
    wanted.has(String(Reflect.get(value, field)))
  );
}

function hasActionsPermissionSettings(
  actions: NonNullable<DesiredState["actions"]>,
): boolean {
  return actions.enabled !== undefined ||
    actions.allowedActions !== undefined ||
    actions.shaPinningRequired !== undefined ||
    actions.selectedActions !== undefined;
}

function defaultActionsPermissionSettings(): Omit<
  CurrentState["actions"],
  "oidc" | "secrets" | "variables"
> {
  return {
    enabled: false,
    allowedActions: "all",
    shaPinningRequired: false,
  };
}

function defaultActionsOidcSettings(): CurrentState["actions"]["oidc"] {
  return {
    subjectClaimTemplate: { source: "default" },
    immutableSubject: false,
  };
}
