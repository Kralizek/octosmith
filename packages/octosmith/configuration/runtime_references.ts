import type { RepositoryMetadata } from "./resolve.ts";
import type { DesiredState } from "../state/types.ts";
import type {
  RepositoryTemplate,
  SecretConfiguration,
  VariableConfiguration,
} from "./types.ts";

/** Describes a runtime-backed value reference in a template. */
export interface RuntimeReference {
  readonly kind: "variable" | "secret";
  readonly name: string;
  readonly target: string;
  readonly scope: "actions" | "dependabot" | "environment";
  readonly environment?: string;
  readonly path: string;
}

/** Describes a structured runtime-reference diagnostic. */
export interface RuntimeReferenceDiagnostic {
  readonly severity: "warning" | "error";
  readonly code:
    | "unresolved_variable"
    | "unresolved_secret"
    | "missing_variable"
    | "missing_secret"
    | "skipped_variable"
    | "skipped_secret";
  readonly name: string;
  readonly template: string;
  readonly path: string;
  readonly resource?: {
    readonly type: "repository";
    readonly name: string;
  };
}

/** Error raised when a required runtime value is unavailable. */
export class RuntimeReferenceError extends Error {
  readonly diagnostic: RuntimeReferenceDiagnostic;
  readonly diagnostics: readonly RuntimeReferenceDiagnostic[];

  constructor(
    diagnostic:
      | RuntimeReferenceDiagnostic
      | readonly RuntimeReferenceDiagnostic[],
  ) {
    const diagnostics = "severity" in diagnostic ? [diagnostic] : diagnostic;
    const first = diagnostics[0];
    if (first === undefined) {
      throw new Error(
        "Runtime reference errors require at least one diagnostic",
      );
    }
    super(renderRuntimeReferenceDiagnostic(first));
    this.diagnostic = first;
    this.diagnostics = diagnostics;
    this.name = "RuntimeReferenceError";
  }
}

/** Error raised when a provider fails after missing references were found. */
export class RuntimeReferenceProviderError extends Error {
  constructor(
    readonly cause: unknown,
    readonly diagnostics: readonly RuntimeReferenceDiagnostic[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RuntimeReferenceProviderError";
  }
}

/** Error raised when a runtime provider confirms that a value is unavailable. */
export class MissingRuntimeValueError extends Error {
  constructor(readonly valueName: string) {
    super("Missing environment value: " + valueName);
    this.name = "MissingRuntimeValueError";
  }
}

/** Collect runtime-backed variables and secrets referenced by a template. */
export function collectRuntimeReferences(
  template: RepositoryTemplate,
): readonly RuntimeReference[] {
  const references: RuntimeReference[] = [];
  const actions = template.repository.actions;

  collectVariables(
    references,
    actions?.variables,
    "repository.actions.variables",
    "actions",
  );
  collectSecrets(
    references,
    actions?.secrets,
    "repository.actions.secrets",
    "actions",
  );
  collectSecrets(
    references,
    template.repository.dependabot?.secrets,
    "repository.dependabot.secrets",
    "dependabot",
  );

  for (
    const [environmentIndex, environment]
      of (template.repository.environments ?? []).entries()
  ) {
    collectVariables(
      references,
      environment.variables,
      `repository.environments[${environmentIndex}].variables`,
      "environment",
      environment.name,
    );
    collectSecrets(
      references,
      environment.secrets,
      `repository.environments[${environmentIndex}].secrets`,
      "environment",
      environment.name,
    );
  }

  return references;
}

/**
 * Check runtime references required by a selected template.
 *
 * Values are snapshotted for this invocation. Missing sources are reported
 * separately and never represented by placeholder values.
 */
export function preflightRuntimeReferences(
  templateName: string,
  template: RepositoryTemplate,
  repository: RepositoryMetadata,
  values: (name: string) => string,
  options: {
    readonly secretValues?: (name: string) => string;
    readonly skipMissingValues?: boolean;
    readonly onSkipped?: (
      reference: RuntimeReference,
      diagnostic: RuntimeReferenceDiagnostic,
    ) => void;
  } = {},
): (name: string) => string {
  const resolved = new Map<string, string>();
  const missing = new Set<string>();
  const diagnostics: RuntimeReferenceDiagnostic[] = [];
  const references = collectRuntimeReferences(template);
  const key = (kind: RuntimeReference["kind"], name: string) =>
    kind + ":" + name;

  for (const reference of references) {
    const referenceKey = key(reference.kind, reference.name);
    if (resolved.has(referenceKey) || missing.has(referenceKey)) {
      continue;
    }

    try {
      const provider = reference.kind === "secret"
        ? options.secretValues ?? values
        : values;
      resolved.set(referenceKey, provider(reference.name));
    } catch (error) {
      if (!isMissingRuntimeValueError(error, reference.name)) {
        if (diagnostics.length > 0) {
          throw new RuntimeReferenceProviderError(error, diagnostics);
        }
        throw error;
      }

      const skipped = options.skipMissingValues === true;
      const diagnostic: RuntimeReferenceDiagnostic = {
        severity: skipped ? "warning" : "error",
        code: skipped
          ? reference.kind === "variable"
            ? "skipped_variable"
            : "skipped_secret"
          : reference.kind === "variable"
          ? "missing_variable"
          : "missing_secret",
        name: reference.name,
        template: templateName,
        path: reference.path,
        resource: {
          type: "repository",
          name: repository.name,
        },
      };

      if (skipped) {
        missing.add(referenceKey);
        for (const skippedReference of references) {
          if (
            skippedReference.kind === reference.kind &&
            skippedReference.name === reference.name
          ) {
            options.onSkipped?.(skippedReference, {
              ...diagnostic,
              code: skippedReference.kind === "variable"
                ? "skipped_variable"
                : "skipped_secret",
              path: skippedReference.path,
            });
          }
        }
        continue;
      }

      missing.add(referenceKey);
      diagnostics.push(diagnostic);
    }
  }

  if (diagnostics.length > 0) {
    throw new RuntimeReferenceError(diagnostics);
  }

  return (name) => {
    const referenceKey = key("variable", name);
    if (missing.has(referenceKey)) {
      throw new MissingRuntimeValueError(name);
    }
    const value = resolved.get(referenceKey);
    return value === undefined ? values(name) : value;
  };
}

/** Remove skipped values while retaining ownership of strict collections. */
export function withoutSkippedRuntimeValues(
  desired: DesiredState,
  skipped: readonly RuntimeReference[],
): DesiredState {
  if (skipped.length === 0) {
    return desired;
  }

  const actions = desired.actions === undefined ? undefined : {
    ...desired.actions,
    secrets: filterSkippedItems(
      desired.actions.secrets,
      skipped,
      "actions",
      "secret",
      (secret) => secret.name,
    ),
    variables: filterSkippedItems(
      desired.actions.variables,
      skipped,
      "actions",
      "variable",
      (variable) => variable.name,
    ),
  };
  const dependabot = desired.dependabot === undefined ? undefined : {
    ...desired.dependabot,
    secrets: filterSkippedItems(
      desired.dependabot.secrets,
      skipped,
      "dependabot",
      "secret",
      (secret) => secret.name,
    ),
  };
  const environments = desired.environments?.map((environment) => ({
    ...environment,
    secrets: filterSkippedItems(
      environment.secrets,
      skipped,
      "environment",
      "secret",
      (secret) => secret.name,
      environment.name,
      desired.collections !== "strict",
    ),
    variables: filterSkippedItems(
      environment.variables,
      skipped,
      "environment",
      "variable",
      (variable) => variable.name,
      environment.name,
      desired.collections !== "strict",
    ),
  }));

  return {
    ...desired,
    ...(actions !== undefined && { actions }),
    ...(dependabot !== undefined && { dependabot }),
    ...(environments !== undefined && { environments }),
  };
}

function filterSkippedItems<T>(
  items: readonly T[] | undefined,
  skipped: readonly RuntimeReference[],
  scope: RuntimeReference["scope"],
  kind: RuntimeReference["kind"],
  name: (item: T) => string,
  environment?: string,
  omitEmpty = false,
): readonly T[] | undefined {
  if (items === undefined) {
    return undefined;
  }

  const skippedNames = new Set(
    skipped.filter((reference) =>
      reference.scope === scope && reference.kind === kind &&
      (environment === undefined || reference.environment === environment)
    ).map((reference) => reference.target),
  );
  const filtered = items.filter((item) => !skippedNames.has(name(item)));

  return omitEmpty && skippedNames.size > 0 && filtered.length === 0
    ? undefined
    : filtered;
}

function isMissingRuntimeValueError(error: unknown, name: string): boolean {
  if (error instanceof MissingRuntimeValueError) {
    return error.valueName === name;
  }
  return error instanceof Error &&
    error.message === "Missing environment value: " + name;
}

/** Build static warnings for runtime-backed references without resolving them. */
export function runtimeReferenceWarnings(
  templateName: string,
  template: RepositoryTemplate,
  isSecretAvailable: (name: string) => boolean = () => false,
): readonly RuntimeReferenceDiagnostic[] {
  return collectRuntimeReferences(template)
    .filter((reference) =>
      reference.kind !== "secret" || !isSecretAvailable(reference.name)
    )
    .map((reference) => ({
      severity: "warning",
      code: reference.kind === "variable"
        ? "unresolved_variable"
        : "unresolved_secret",
      name: reference.name,
      template: templateName,
      path: reference.path,
    }));
}

/** Render the summary line for a runtime-reference diagnostic. */
export function describeRuntimeReferenceDiagnostic(
  diagnostic: Pick<RuntimeReferenceDiagnostic, "severity" | "code" | "name">,
): string {
  const kind = diagnostic.code.endsWith("_secret") ? "secret" : "variable";
  if (diagnostic.code.startsWith("skipped_")) {
    return `Skipped ${kind} "${diagnostic.name}": runtime value unavailable.`;
  }
  const availability = diagnostic.severity === "error"
    ? "is not available in the current context"
    : "requires a runtime value";
  return `Required ${kind} "${diagnostic.name}" ${availability}.`;
}

/** Render the reference lines for a runtime-reference diagnostic. */
export function renderRuntimeReferenceReference(
  diagnostic: Pick<
    RuntimeReferenceDiagnostic,
    "template" | "path" | "resource"
  >,
): readonly string[] {
  const lines = [`  template: ${diagnostic.template}`];

  if (diagnostic.resource !== undefined) {
    lines.push(
      `  type: ${diagnostic.resource.type}`,
      `  name: ${diagnostic.resource.name}`,
    );
  }

  lines.push(`  path: ${diagnostic.path}`);
  return lines;
}

/** Render a runtime-reference diagnostic without exposing values. */
export function renderRuntimeReferenceDiagnostic(
  diagnostic: RuntimeReferenceDiagnostic,
): string {
  const lines = [
    describeRuntimeReferenceDiagnostic(diagnostic),
    "",
    "Referenced by:",
    ...renderRuntimeReferenceReference(diagnostic),
  ];
  return lines.join("\n");
}

function collectVariables(
  target: RuntimeReference[],
  variables: readonly VariableConfiguration[] | undefined,
  path: string,
  scope: "actions" | "environment",
  environment?: string,
): void {
  for (const [index, variable] of (variables ?? []).entries()) {
    if (typeof variable === "string") {
      target.push({
        kind: "variable",
        name: variable,
        target: variable,
        scope,
        ...(environment !== undefined && { environment }),
        path: `${path}[${index}]`,
      });
    } else if ("from" in variable) {
      target.push({
        kind: "variable",
        name: variable.from,
        target: variable.to,
        scope,
        ...(environment !== undefined && { environment }),
        path: `${path}[${index}]`,
      });
    }
  }
}

function collectSecrets(
  target: RuntimeReference[],
  secrets: readonly SecretConfiguration[] | undefined,
  path: string,
  scope: "actions" | "dependabot" | "environment",
  environment?: string,
): void {
  for (const [index, secret] of (secrets ?? []).entries()) {
    target.push({
      kind: "secret",
      name: typeof secret === "string" ? secret : secret.from,
      target: typeof secret === "string" ? secret : secret.to,
      scope,
      ...(environment !== undefined && { environment }),
      path: `${path}[${index}]`,
    });
  }
}
