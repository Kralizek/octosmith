import type { LoadedConfiguration } from "./load.ts";
import type { RepositoryCreationSpecification } from "./creation.ts";
import { type RuntimeValueProvider, shouldIncludeSecrets } from "./resolve.ts";
import {
  preflightRuntimeReferences,
  type RuntimeReference,
  type RuntimeReferenceDiagnostic,
  RuntimeReferenceError,
  RuntimeReferenceProviderError,
  type RuntimeValueSnapshotProviders,
  secretPolicyDiagnostics,
} from "./runtime_references.ts";

/** Runtime inputs resolved once for a single creation invocation. */
export interface CreationRuntimeSnapshot extends RuntimeValueSnapshotProviders {
  readonly includeSecrets: boolean;
  readonly skippedReferences: readonly RuntimeReference[];
  readonly skippedDiagnostics: readonly RuntimeReferenceDiagnostic[];
}

/** Check the runtime inputs participating in a resolved creation. */
export function checkCreationRuntimeReferences(
  loaded: LoadedConfiguration,
  specification: RepositoryCreationSpecification,
  options: {
    readonly values: RuntimeValueProvider;
    readonly secretValues?: RuntimeValueProvider;
    readonly includeSecrets?: boolean;
    readonly skipMissingValues?: boolean;
  },
): {
  readonly diagnostics: readonly RuntimeReferenceDiagnostic[];
  readonly error?: string;
  readonly snapshot?: CreationRuntimeSnapshot;
} {
  if (!specification.ready || !specification.repository) {
    throw new Error("Runtime checks require a ready creation specification");
  }
  const includeSecrets = shouldIncludeSecrets(
    loaded.configuration,
    options.includeSecrets,
  );
  const diagnostics: RuntimeReferenceDiagnostic[] = [];
  const skippedReferences: RuntimeReference[] = [];
  let providers: RuntimeValueSnapshotProviders | undefined;
  let error: string | undefined;
  try {
    preflightRuntimeReferences(
      specification.template,
      loaded.templates[specification.template],
      specification.repository,
      options.values,
      {
        secretValues: options.secretValues,
        includeSecrets,
        skipMissingValues: options.skipMissingValues,
        onSkipped: (reference, diagnostic) => {
          skippedReferences.push(reference);
          diagnostics.push(diagnostic);
        },
        onSnapshot: (snapshot) => providers = snapshot,
      },
    );
  } catch (cause) {
    if (
      cause instanceof RuntimeReferenceError ||
      cause instanceof RuntimeReferenceProviderError
    ) {
      diagnostics.push(...cause.diagnostics);
    }
    error = cause instanceof RuntimeReferenceError
      ? "Required runtime values are unavailable."
      : "Runtime value provider failed; check the provider and its permissions.";
  }
  const skippedDiagnostics = [...diagnostics];
  diagnostics.push(...secretPolicyDiagnostics({
    template: specification.template,
    repository: specification.repository.name,
    ...(!includeSecrets && { secretsExcluded: true }),
  }));
  return {
    diagnostics,
    ...(error !== undefined && { error }),
    ...(error === undefined && providers && {
      snapshot: {
        ...providers,
        includeSecrets,
        skippedReferences,
        skippedDiagnostics,
      },
    }),
  };
}
