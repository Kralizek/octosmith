import {
  classifyResource,
  equalContentHash,
  type ExecutableResourcePlan,
  hashCanonical,
  hashEffectiveConfiguration,
  hashEffectiveTemplate,
  type LoadedConfiguration,
  persistedOperationSecretSources,
  type PersistedPlanArtifact,
  type PersistedResourcePlan,
  projectOwnedCurrentState,
  type PullRequestResult,
  resolveDesiredState,
  restoreEvaluations,
  type RuntimeReferenceDiagnostic,
  withoutSkippedRuntimeValues,
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
  options: {
    readonly skipMissingValues?: boolean;
    readonly onPullRequest?: (
      result: PullRequestResult,
    ) => void | Promise<void>;
  } = {},
): Promise<PersistedPlanPreflight> {
  if (options.skipMissingValues) {
    throw new Error(
      "Cannot use --skip-missing-values when applying a saved plan. " +
        "Create a new plan with --skip-missing-values instead; saved plans replay exactly as reviewed.",
    );
  }

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
          ...(resource.managedFiles !== undefined && {
            managedFiles: resource.managedFiles,
          }),
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
    options.onPullRequest,
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
  let stateDesired: import("@octosmith/octosmith").DesiredState;
  const skipped = resource.skippedRuntimeReferences ?? [];
  const diagnostics: RuntimeReferenceDiagnostic[] = skipped.map((
    reference,
  ) => ({
    severity: "warning",
    code: reference.kind === "variable" ? "skipped_variable" : "skipped_secret",
    name: reference.name,
    template: resource.template.id,
    path: reference.path,
    resource: { type: "repository", name: resource.name },
  }));

  try {
    const classification = classifyResource(loaded, metadata);

    if (
      classification.status !== "matched" ||
      classification.template !== resource.template.id
    ) {
      return { state: "template" };
    }

    const template = loaded.templates[classification.template];
    stateDesired = await resolveDesiredState(
      loaded,
      metadata,
      (name) => "persisted-plan:" + name,
      { skippedRuntimeReferences: skipped },
    );
    desired = withoutSkippedRuntimeValues(
      stateDesired,
      skipped,
    );
    const templateHash = await hashEffectiveTemplate(template, stateDesired);

    if (!equalContentHash(templateHash, resource.template)) {
      return { state: "template" };
    }
  } catch {
    return { state: "template" };
  }

  try {
    const current = await runtime.read(desired, resource.operations);
    if (current.filesBaseSha !== undefined) {
      const expected = {
        branch: current.filesBranch ?? current.settings.defaultBranch,
        baseSha: current.filesBaseSha,
        files: [...(desired.files ?? [])].sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0
        ),
      };
      if (
        resource.managedFiles === undefined ||
        !equalContentHash(
          await hashCanonical(expected),
          await hashCanonical(resource.managedFiles),
        )
      ) {
        return { state: "state" };
      }
    }
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
