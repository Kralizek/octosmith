import {
  classifyResource,
  collectRuntimeReferences,
  equalContentHash,
  type ExecutableResourcePlan,
  hashCanonical,
  hashEffectiveConfiguration,
  hashEffectiveTemplate,
  type LoadedConfiguration,
  MissingRuntimeValueError,
  persistedOperationSecretSources,
  preflightRuntimeReferences,
  RuntimeReferenceError,
  type RuntimeReference,
  type RuntimeReferenceDiagnostic,
  type PersistedPlanArtifact,
  type PersistedResourcePlan,
  projectOwnedCurrentState,
  resolveDesiredState,
  restoreEvaluations,
} from "@octosmith/octosmith";
import type { ApplyRuntime } from "./apply.ts";
import { withoutSkippedRuntimeValues } from "./apply.ts";
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
  options: { readonly skipMissingValues?: boolean } = {},
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
    const inspected = await inspectResource(
      runtime,
      loaded,
      resource,
      options.skipMissingValues ?? false,
    );
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
        ...(inspected.diagnostics !== undefined && {
          diagnostics: inspected.diagnostics,
        }),
        ...(resource.skippedRuntimeReferences !== undefined && {
          skippedRuntimeReferences: resource.skippedRuntimeReferences,
        }),
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
  skipMissingValues: boolean,
): Promise<{
  readonly state: PersistedResourcePreflightState;
  readonly desired?: import("@octosmith/octosmith").DesiredState;
  readonly current?: import("@octosmith/octosmith").CurrentState;
  readonly diagnostics?: readonly RuntimeReferenceDiagnostic[];
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
  let runtimePreflightError: unknown;
  const skipped: RuntimeReference[] = [];
  const diagnostics: RuntimeReferenceDiagnostic[] = [];

  try {
    const classification = classifyResource(loaded, metadata);

    if (
      classification.status !== "matched" ||
      classification.template !== resource.template.id
    ) {
      return { state: "template" };
    }

    const template = loaded.templates[classification.template];
    const values = runtime.value;
    let runtimeValues: (name: string) => string = (name) =>
      "persisted-plan:" + name;
    if (skipMissingValues) {
      runtimeValues = preflightRuntimeReferences(
        classification.template,
        template,
        metadata,
        (name) => {
          if (values === undefined) {
            throw new MissingRuntimeValueError(name);
          }
          try {
            return values(name);
          } catch (error) {
            runtimePreflightError = error;
            throw error;
          }
        },
        {
          skipMissingValues: true,
          onSkipped: (reference, diagnostic) => {
            skipped.push(reference);
            diagnostics.push(diagnostic);
          },
        },
      );
    } else {
      for (
        const reference of collectRuntimeReferences(template).filter((item) =>
          item.kind === "secret"
        )
      ) {
        if (values === undefined) {
          throw new Error(
            'Required secret "' + reference.name +
              '" is not available in the current context',
          );
        }
        try {
          values(reference.name);
        } catch (error) {
          runtimePreflightError = error;
          throw error;
        }
      }
    }

    desired = withoutSkippedRuntimeValues(
      await resolveDesiredState(loaded, metadata, runtimeValues),
      resource.skippedRuntimeReferences ?? [],
    );
    const templateHash = await hashEffectiveTemplate(template, desired);

    if (!equalContentHash(templateHash, resource.template)) {
      return { state: "template" };
    }
  } catch (error) {
    if (
      runtimePreflightError !== undefined ||
      error instanceof RuntimeReferenceError
    ) {
      throw error;
    }
    return { state: "template" };
  }

  try {
    const current = await runtime.read(desired, resource.operations);
    const stateHash = await hashCanonical(
      projectOwnedCurrentState(
        current,
        desired,
        resource.operations,
        resource.skippedRuntimeReferences,
      ),
    );

    return {
      state: equalContentHash(stateHash, resource.state) ? "valid" : "state",
      desired,
      current,
      ...(diagnostics.length > 0 && { diagnostics }),
    };
  } catch {
    return { state: "state" };
  }
}
