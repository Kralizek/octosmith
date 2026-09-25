import {
  collectRuntimeReferences,
  equalContentHash,
  type ExecutableResourcePlan,
  hashCanonical,
  hashEffectiveConfiguration,
  hashEffectiveTemplate,
  type LoadedConfiguration,
  matchesScope,
  persistedOperationSecretSources,
  type PersistedPlanArtifact,
  type PersistedResourcePlan,
  projectOwnedCurrentState,
  resolveDesiredState,
  restoreEvaluations,
} from "@octosmith/octosmith";
import type { ApplyRuntime } from "./apply.ts";
import { executeExecutableResources } from "./execution.ts";

/** Persisted-plan preflight state for one resource. */
export type PersistedResourcePreflightState =
  | "valid"
  | "template"
  | "state";

/** One resource row in a persisted-plan preflight report. */
export interface PersistedResourcePreflight {
  readonly type: "repository";
  readonly name: string;
  readonly state: PersistedResourcePreflightState;
}

/** Complete persisted-plan preflight report. */
export interface PersistedPlanPreflight {
  readonly configuration: "valid" | "changed";
  readonly resources: readonly PersistedResourcePreflight[];
}

/** Error carrying the complete stale-plan preflight result. */
export class PersistedPlanStaleError extends Error {
  constructor(readonly preflight: PersistedPlanPreflight) {
    super("The saved plan is stale");
    this.name = "PersistedPlanStaleError";
  }
}

/** Preflight and execute one persisted plan without rebuilding its operations. */
export async function applyPersistedPlan(
  runtime: ApplyRuntime,
  loaded: LoadedConfiguration,
  artifact: PersistedPlanArtifact,
  onResourceApplied: (
    report: import("@octosmith/octosmith").RepositoryReport,
  ) => void | Promise<void>,
): Promise<PersistedPlanPreflight> {
  const configuration = equalContentHash(
      await hashEffectiveConfiguration(loaded.configuration),
      artifact.configuration,
    )
    ? "valid" as const
    : "changed" as const;

  preflightPersistedOperationSecrets(runtime, artifact);

  const resources: PersistedResourcePreflight[] = [];
  const prepared: ExecutableResourcePlan[] = [];
  for (const resource of artifact.resources) {
    const inspected = await inspectResource(runtime, loaded, resource);
    resources.push({
      type: resource.type,
      name: resource.name,
      state: inspected.state,
    });

    if (
      inspected.state === "valid" &&
      inspected.desired !== undefined &&
      inspected.current !== undefined
    ) {
      prepared.push({
        desired: inspected.desired,
        current: inspected.current,
        plan: {
          repository: resource.name,
          operations: resource.operations,
        },
        evaluations: restoreEvaluations(
          resource.evaluations,
          resource.operations,
        ),
      });
    }
  }

  const preflight = { configuration, resources };

  if (
    configuration !== "valid" ||
    resources.some((resource) => resource.state !== "valid")
  ) {
    throw new PersistedPlanStaleError(preflight);
  }

  await executeExecutableResources(
    runtime,
    prepared,
    onResourceApplied,
  );
  return preflight;
}

function preflightPersistedOperationSecrets(
  runtime: ApplyRuntime,
  artifact: PersistedPlanArtifact,
): void {
  const sources = persistedOperationSecretSources(
    artifact.resources.flatMap((resource) => resource.operations),
  );

  if (sources.length === 0) {
    return;
  }

  if (runtime.value === undefined) {
    throw new Error(
      "Persisted plan requires secret values but the runtime cannot resolve them",
    );
  }

  for (const source of sources) {
    runtime.value(source);
  }
}

/** Render persisted-plan preflight as a compact human-readable table. */
export function renderPersistedPlanPreflight(
  preflight: PersistedPlanPreflight,
): string {
  const typeWidth = Math.max(
    "TYPE".length,
    ...preflight.resources.map((resource) => resource.type.length),
  );
  const nameWidth = Math.max(
    "NAME".length,
    ...preflight.resources.map((resource) => resource.name.length),
  );

  const rows = [
    "TYPE".padEnd(typeWidth) + "  " +
    "NAME".padEnd(nameWidth) + "  STATE",
    ...preflight.resources.map((resource) =>
      resource.type.padEnd(typeWidth) + "  " +
      resource.name.padEnd(nameWidth) + "  " +
      resource.state
    ),
  ];

  return [
    "Error: the saved plan is stale.",
    "",
    "Configuration: " + preflight.configuration,
    "",
    ...rows,
    "",
    "No changes were applied.",
    "Create a new plan before applying.",
  ].join("\n");
}

async function inspectResource(
  runtime: ApplyRuntime,
  loaded: LoadedConfiguration,
  resource: PersistedResourcePlan,
): Promise<{
  readonly state: PersistedResourcePreflightState;
  readonly desired?: import("@octosmith/octosmith").DesiredState;
  readonly current?: import("@octosmith/octosmith").CurrentState;
}> {
  let metadata: import("@octosmith/octosmith").RepositoryMetadata;

  try {
    const discovery = await runtime.discover(loaded, resource.name);

    if (discovery.failures.length > 0 || discovery.repositories.length !== 1) {
      return { state: "state" };
    }

    metadata = discovery.repositories[0];
  } catch {
    return { state: "state" };
  }

  let desired: import("@octosmith/octosmith").DesiredState;
  let secretPreflightError: unknown;

  try {
    const matches = Object.entries(loaded.templates).filter(([, template]) =>
      matchesScope(template.match, metadata)
    );

    if (matches.length !== 1 || matches[0][0] !== resource.template.id) {
      return { state: "template" };
    }

    const [[, template]] = matches;
    const values = runtime.value;
    for (const reference of collectRuntimeReferences(template)) {
      if (reference.kind !== "secret") {
        continue;
      }
      if (values === undefined) {
        throw new Error(
          'Required secret "' + reference.name +
            '" is not available in the current context',
        );
      }
      try {
        values(reference.name);
      } catch (error) {
        secretPreflightError = error;
        throw error;
      }
    }

    desired = await resolveDesiredState(
      loaded,
      metadata,
      (name) => "persisted-plan:" + name,
    );
    const templateHash = await hashEffectiveTemplate(template, desired);

    if (!equalContentHash(templateHash, resource.template)) {
      return { state: "template" };
    }
  } catch (error) {
    if (secretPreflightError !== undefined) {
      throw error;
    }
    return { state: "template" };
  }

  try {
    const current = await runtime.read(desired);
    const stateHash = await hashCanonical(
      projectOwnedCurrentState(current, desired, resource.operations),
    );

    return {
      state: equalContentHash(stateHash, resource.state) ? "valid" : "state",
      desired,
      current,
    };
  } catch {
    return { state: "state" };
  }
}
