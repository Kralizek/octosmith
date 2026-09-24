import type { RepositoryMetadata } from "./resolve.ts";
import type {
  RepositoryTemplate,
  SecretConfiguration,
  VariableConfiguration,
} from "./types.ts";

/** Describes a runtime-backed value reference in a template. */
export interface RuntimeReference {
  readonly kind: "variable" | "secret";
  readonly name: string;
  readonly path: string;
}

/** Describes a structured runtime-reference diagnostic. */
export interface RuntimeReferenceDiagnostic {
  readonly severity: "warning" | "error";
  readonly code:
    | "unresolved_variable"
    | "unresolved_secret"
    | "missing_variable"
    | "missing_secret";
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
  constructor(readonly diagnostic: RuntimeReferenceDiagnostic) {
    super(renderRuntimeReferenceDiagnostic(diagnostic));
    this.name = "RuntimeReferenceError";
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
  );
  collectSecrets(
    references,
    actions?.secrets,
    "repository.actions.secrets",
  );
  collectSecrets(
    references,
    template.repository.dependabot?.secrets,
    "repository.dependabot.secrets",
  );

  for (
    const [environmentIndex, environment]
      of (template.repository.environments ?? []).entries()
  ) {
    collectVariables(
      references,
      environment.variables,
      `repository.environments[${environmentIndex}].variables`,
    );
    collectSecrets(
      references,
      environment.secrets,
      `repository.environments[${environmentIndex}].secrets`,
    );
  }

  return references;
}

/**
 * Check runtime references required by a selected template.
 *
 * Variable values are snapshotted for desired-state resolution. Secret values
 * are checked for availability but deliberately discarded.
 */
export function preflightRuntimeReferences(
  templateName: string,
  template: RepositoryTemplate,
  repository: RepositoryMetadata,
  values: (name: string) => string,
): (name: string) => string {
  const resolved = new Map<string, string>();

  for (const reference of collectRuntimeReferences(template)) {
    if (resolved.has(reference.name)) {
      continue;
    }

    try {
      resolved.set(reference.name, values(reference.name));
    } catch {
      throw new RuntimeReferenceError({
        severity: "error",
        code: reference.kind === "variable"
          ? "missing_variable"
          : "missing_secret",
        name: reference.name,
        template: templateName,
        path: reference.path,
        resource: {
          type: "repository",
          name: repository.name,
        },
      });
    }
  }

  return (name) => {
    const value = resolved.get(name);
    return value === undefined ? values(name) : value;
  };
}

/** Build static warnings for runtime-backed references without resolving them. */
export function runtimeReferenceWarnings(
  templateName: string,
  template: RepositoryTemplate,
): readonly RuntimeReferenceDiagnostic[] {
  return collectRuntimeReferences(template).map((reference) => ({
    severity: "warning",
    code: reference.kind === "variable"
      ? "unresolved_variable"
      : "unresolved_secret",
    name: reference.name,
    template: templateName,
    path: reference.path,
  }));
}

/** Render a runtime-reference diagnostic without exposing values. */
export function renderRuntimeReferenceDiagnostic(
  diagnostic: RuntimeReferenceDiagnostic,
): string {
  const kind = diagnostic.code.endsWith("_secret") ? "secret" : "variable";
  const availability = diagnostic.severity === "error"
    ? "is not available in the current context"
    : "requires a runtime value";

  const lines = [
    `Required ${kind} "${diagnostic.name}" ${availability}.`,
    "",
    "Referenced by:",
    `  template: ${diagnostic.template}`,
  ];

  if (diagnostic.resource !== undefined) {
    lines.push(
      `  type: ${diagnostic.resource.type}`,
      `  name: ${diagnostic.resource.name}`,
    );
  }

  lines.push(`  path: ${diagnostic.path}`);
  return lines.join("\n");
}

function collectVariables(
  target: RuntimeReference[],
  variables: readonly VariableConfiguration[] | undefined,
  path: string,
): void {
  for (const [index, variable] of (variables ?? []).entries()) {
    if (typeof variable === "string") {
      target.push({
        kind: "variable",
        name: variable,
        path: `${path}[${index}]`,
      });
    } else if ("from" in variable) {
      target.push({
        kind: "variable",
        name: variable.from,
        path: `${path}[${index}]`,
      });
    }
  }
}

function collectSecrets(
  target: RuntimeReference[],
  secrets: readonly SecretConfiguration[] | undefined,
  path: string,
): void {
  for (const [index, secret] of (secrets ?? []).entries()) {
    target.push({
      kind: "secret",
      name: typeof secret === "string" ? secret : secret.from,
      path: `${path}[${index}]`,
    });
  }
}
