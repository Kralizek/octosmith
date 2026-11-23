import type { LoadedConfiguration } from "./load.ts";
import type { RepositoryCreationSpecification } from "./creation.ts";
import { type RuntimeValueProvider, shouldIncludeSecrets } from "./resolve.ts";
import {
  preflightRuntimeReferences,
  type RuntimeReferenceDiagnostic,
  RuntimeReferenceError,
  RuntimeReferenceProviderError,
  secretPolicyDiagnostics,
} from "./runtime_references.ts";

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
} {
  if (!specification.ready || !specification.repository) {
    throw new Error("Runtime checks require a ready creation specification");
  }
  const includeSecrets = shouldIncludeSecrets(
    loaded.configuration,
    options.includeSecrets,
  );
  const diagnostics: RuntimeReferenceDiagnostic[] = [];
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
        onSkipped: (_reference, diagnostic) => diagnostics.push(diagnostic),
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
  diagnostics.push(...secretPolicyDiagnostics({
    template: specification.template,
    repository: specification.repository.name,
    ...(!includeSecrets && { secretsExcluded: true }),
  }));
  return { diagnostics, ...(error !== undefined && { error }) };
}
