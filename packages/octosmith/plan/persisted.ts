import { Ajv2020 } from "ajv/2020";
import type {
  ApplyEvaluation,
  CurrentState,
  DesiredState,
  LoadedConfiguration,
  Operation,
  Plan,
  RepositoryTemplate,
} from "../mod.ts";
import { type ContentHash, hashCanonical } from "./canonical.ts";
import { projectOwnedCurrentState } from "./owned_state.ts";
import { assertPersistedOperationsExecutable } from "./operation_contract.ts";
import planSchema from "./plan.schema.json" with {
  type: "json",
};

const validatePersistedPlan = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
}).compile(planSchema);

/** Persisted executable plan artifact format identifier. */
export const PERSISTED_PLAN_FORMAT = "octosmith-plan" as const;

/** Current persisted executable plan artifact version. */
export const PERSISTED_PLAN_VERSION = 1 as const;

/** Describes a persisted apply evaluation. */
export interface PersistedApplyEvaluation {
  readonly type: ApplyEvaluation["type"];
  readonly details: Readonly<Record<string, unknown>>;
  readonly operationIndex?: number;
}

/** Describes one persisted resource plan. */
export interface PersistedResourcePlan {
  readonly type: "repository";
  readonly name: string;
  readonly template: ContentHash & {
    readonly id: string;
    readonly displayName?: string;
  };
  readonly state: ContentHash;
  readonly operations: readonly Operation[];
  readonly evaluations: readonly PersistedApplyEvaluation[];
}

/** Describes a versioned persisted executable plan. */
export interface PersistedPlanArtifact {
  readonly format: typeof PERSISTED_PLAN_FORMAT;
  readonly version: typeof PERSISTED_PLAN_VERSION;
  readonly createdAt: string;
  readonly configuration: ContentHash;
  readonly resources: readonly PersistedResourcePlan[];
}

/** Complete in-memory executable plan for one resource. */
export interface ExecutableResourcePlan {
  readonly desired: DesiredState;
  readonly current: CurrentState;
  readonly plan: Plan;
  readonly evaluations: readonly ApplyEvaluation[];
}

/** @deprecated Use ExecutableResourcePlan. */
export type PersistedResourceInput = ExecutableResourcePlan;

/** Build a complete persisted executable plan artifact. */
export async function createPersistedPlanArtifact(
  loaded: LoadedConfiguration,
  resources: readonly ExecutableResourcePlan[],
  createdAt: Date = new Date(),
): Promise<PersistedPlanArtifact> {
  return {
    format: PERSISTED_PLAN_FORMAT,
    version: PERSISTED_PLAN_VERSION,
    createdAt: createdAt.toISOString(),
    configuration: await hashEffectiveConfiguration(loaded.configuration),
    resources: await Promise.all(resources.map(async (resource) => {
      const template = loaded.templates[resource.desired.template];

      if (template === undefined) {
        throw new Error(
          "Missing template while persisting resource plan: " +
            resource.desired.template,
        );
      }

      return {
        type: "repository" as const,
        name: resource.plan.repository,
        template: {
          id: resource.desired.template,
          ...(resource.desired.templateName !== undefined && {
            displayName: resource.desired.templateName,
          }),
          ...await hashEffectiveTemplate(template, resource.desired),
        },
        state: await hashCanonical(
          projectOwnedCurrentState(
            resource.current,
            resource.desired,
            resource.plan.operations,
          ),
        ),
        operations: resource.plan.operations,
        evaluations: persistEvaluations(
          resource.evaluations,
          resource.plan.operations,
        ),
      };
    })),
  };
}

/** Hash root configuration after applying all execution-relevant defaults. */
export async function hashEffectiveConfiguration(
  configuration: LoadedConfiguration["configuration"],
): Promise<ContentHash> {
  return await hashCanonical(normalizeConfigurationForHash(configuration));
}

function normalizeConfigurationForHash(
  configuration: LoadedConfiguration["configuration"],
): unknown {
  const repositories = configuration.repositories;
  const fileChanges = repositories.fileChanges ??
    { mode: "pull_request" as const };
  const effectiveFileChanges = fileChanges.mode === "direct"
    ? {
      mode: "direct" as const,
      commit: {
        message: fileChanges.commit?.message ??
          "Octosmith: reconcile managed files",
      },
    }
    : {
      mode: "pull_request" as const,
      commit: {
        message: fileChanges.commit?.message ??
          "Octosmith: reconcile managed files",
      },
      pullRequest: {
        branchPrefix: fileChanges.pullRequest?.branchPrefix ?? "octosmith/",
        title: fileChanges.pullRequest?.title ??
          "Octosmith: reconcile managed files",
        labels: fileChanges.pullRequest?.labels ?? [],
      },
    };

  return {
    ...configuration,
    repositories: {
      ...repositories,
      scope: {
        include: normalizeSelectorForHash(repositories.scope.include),
        ...(repositories.scope.exclude !== undefined && {
          exclude: normalizeSelectorForHash(repositories.scope.exclude),
        }),
      },
      settings: {
        collectionManagement: repositories.settings?.collectionManagement ??
          "explicit",
        unmatchedRepositories: repositories.settings?.unmatchedRepositories ??
          "error",
      },
      fileChanges: effectiveFileChanges,
    },
  };
}

function normalizeSelectorForHash(
  selector:
    LoadedConfiguration["configuration"]["repositories"]["scope"]["include"],
): unknown {
  if (selector === "all") {
    return {};
  }

  return {
    ...(selector.names !== undefined && {
      names: [...new Set(selector.names)].sort(),
    }),
    ...(selector.teams !== undefined && {
      teams: [...new Set(selector.teams)].sort(),
    }),
    ...(selector.visibility !== undefined && {
      visibility: [
        ...new Set(
          Array.isArray(selector.visibility)
            ? selector.visibility
            : [selector.visibility],
        ),
      ].sort(),
    }),
    ...(selector.properties !== undefined && {
      properties: selector.properties,
    }),
  };
}

function normalizeTemplateForHash(
  template: Omit<RepositoryTemplate, "includes">,
): unknown {
  const repository = template.repository;
  const customProperties = repository.customProperties === undefined
    ? undefined
    : Object.fromEntries(
      Object.entries(repository.customProperties).map(([name, value]) => [
        name,
        Array.isArray(value) ? [...value].sort() : value,
      ]),
    );

  return {
    ...template,
    match: {
      include: normalizeSelectorForHash(template.match.include),
      ...(template.match.exclude !== undefined && {
        exclude: normalizeSelectorForHash(template.match.exclude),
      }),
    },
    repository: {
      ...repository,
      ...(repository.settings?.topics !== undefined && {
        settings: {
          ...repository.settings,
          topics: [...repository.settings.topics].sort(),
        },
      }),
      ...(customProperties !== undefined && { customProperties }),
      ...(repository.actions?.selectedActions?.patternsAllowed !== undefined &&
        {
          actions: {
            ...repository.actions,
            selectedActions: {
              ...repository.actions.selectedActions,
              patternsAllowed: [
                ...repository.actions.selectedActions.patternsAllowed,
              ].sort(),
            },
          },
        }),
    },
  };
}

/** Hash one effective resource template using the resolved planning snapshot. */
export async function hashEffectiveTemplate(
  template: RepositoryTemplate,
  desired: DesiredState,
): Promise<ContentHash> {
  const sources: Record<string, string> = {};
  const desiredFiles = new Map(
    (desired.files ?? []).map((file) => [file.path, file]),
  );
  const { includes: _composition, ...templateWithoutComposition } = template;
  const effectiveTemplate = normalizeTemplateForHash(
    templateWithoutComposition,
  );

  for (const [path, file] of Object.entries(template.repository.files ?? {})) {
    if (file.ensure === "absent") {
      continue;
    }

    const resolved = desiredFiles.get(path);
    if (resolved === undefined || resolved.ensure === "absent") {
      throw new Error(
        "Missing resolved file snapshot while hashing template: " + path,
      );
    }

    const existing = sources[file.source];
    if (existing !== undefined && existing !== resolved.content) {
      throw new Error(
        "Resolved file source has inconsistent contents: " + file.source,
      );
    }

    sources[file.source] = resolved.content;
  }

  return await hashCanonical({
    template: effectiveTemplate,
    ...(Object.keys(sources).length > 0 && { sources }),
  });
}

/** Restore runtime apply evaluations against the exact persisted operations. */
export function restoreEvaluations(
  persisted: readonly PersistedApplyEvaluation[],
  operations: readonly Operation[],
): readonly ApplyEvaluation[] {
  return persisted.map((evaluation) => ({
    type: evaluation.type,
    details: evaluation.details,
    ...(evaluation.operationIndex !== undefined && {
      operation: operationAt(operations, evaluation.operationIndex),
    }),
  }));
}

/** Parse and validate a persisted plan artifact. */
export function parsePersistedPlanArtifact(
  value: unknown,
): PersistedPlanArtifact {
  if (value === null || typeof value !== "object") {
    throw new Error("Persisted plan must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  if (record.format !== PERSISTED_PLAN_FORMAT) {
    throw new Error("Unsupported persisted plan format");
  }
  if (record.version !== PERSISTED_PLAN_VERSION) {
    throw new Error(
      "Unsupported persisted plan version: " + String(record.version),
    );
  }

  if (!validatePersistedPlan(value)) {
    const errors = validatePersistedPlan.errors?.map((error) =>
      (error.instancePath || "/") + " " + error.message
    ).join("; ");
    throw new Error("Invalid persisted plan: " + errors);
  }

  const artifact = value as unknown as PersistedPlanArtifact;

  const resourceIdentities = new Set<string>();
  for (const resource of artifact.resources) {
    const identity = resource.type + ":" + resource.name;
    if (resourceIdentities.has(identity)) {
      throw new Error(
        "Invalid persisted plan: duplicate resource identity " + identity,
      );
    }
    resourceIdentities.add(identity);
  }

  if (!isRfc3339DateTime(artifact.createdAt)) {
    throw new Error(
      "Invalid persisted plan: createdAt must be an RFC 3339 date-time",
    );
  }

  for (const resource of artifact.resources) {
    assertPersistedOperationsExecutable(resource.operations);

    for (const evaluation of resource.evaluations) {
      if (
        evaluation.operationIndex !== undefined &&
        evaluation.operationIndex >= resource.operations.length
      ) {
        throw new Error(
          "Invalid persisted plan: evaluation operationIndex is out of range",
        );
      }
    }
  }

  return artifact;
}

function persistEvaluations(
  evaluations: readonly ApplyEvaluation[],
  operations: readonly Operation[],
): readonly PersistedApplyEvaluation[] {
  return evaluations.map((evaluation) => {
    const operationIndex = evaluation.operation === undefined
      ? undefined
      : operations.indexOf(evaluation.operation);

    if (
      evaluation.operation !== undefined &&
      operationIndex !== undefined &&
      operationIndex < 0
    ) {
      throw new Error(
        "Apply evaluation references an operation outside its plan",
      );
    }

    return {
      type: evaluation.type,
      details: evaluation.details,
      ...(operationIndex !== undefined && { operationIndex }),
    };
  });
}

function operationAt(
  operations: readonly Operation[],
  index: number,
): Operation {
  const operation = operations[index];
  if (operation === undefined) {
    throw new Error(
      "Persisted evaluation references an invalid operation index",
    );
  }
  return operation;
}

function isRfc3339DateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
      .exec(
        value,
      );

  if (match === null || Number.isNaN(Date.parse(value))) {
    return false;
  }

  const [, year, month, day, hour, minute, second, , zone] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);

  if (
    numericMonth < 1 || numericMonth > 12 ||
    numericDay < 1 ||
    numericDay >
      new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return false;
  }

  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) {
      return false;
    }
  }

  return true;
}
