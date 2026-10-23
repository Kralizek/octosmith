import type { PropertyValue, RepositoryVisibility } from "../types.ts";
import type { LoadedConfiguration } from "./load.ts";
import {
  classifyResource,
  type RepositoryMetadata,
  resolveTemplateIdentity,
} from "./resolve.ts";
import {
  type ConfigurationValidationIssue,
  type ConfigurationValidationIssueCode,
  type EffectiveRepositorySelectorChoices,
  type EffectiveRepositorySelectorConstraints,
  effectiveRepositorySelectorIntersection,
  matchesEffectiveRepositorySelectorIntersection,
  validateLoadedConfigurationDetailed,
} from "./validate.ts";

/** Explicit metadata supplied when preparing a repository creation. */
export interface RepositoryCreationInput {
  readonly template: string;
  readonly name?: string;
  readonly visibility?: RepositoryVisibility;
  readonly teams?: readonly string[];
  readonly properties?: Readonly<Record<string, PropertyValue>>;
}

/** A structured issue found while preparing a repository creation. */
export interface RepositoryCreationDiagnostic {
  readonly code: ConfigurationValidationIssueCode | RepositoryCreationIssueCode;
  readonly message: string;
  readonly template: string;
  readonly templates?: readonly string[];
  readonly path?: string;
  readonly validationIssue?: ConfigurationValidationIssue;
}

/** Creation-specific preflight issue codes. */
export type RepositoryCreationIssueCode =
  | "invalid_name"
  | "name_required"
  | "name_outside_intersection"
  | "visibility_required"
  | "visibility_not_allowed"
  | "property_conflict"
  | "template_mismatch"
  | "template_overlap";

/** Semantic validation details without synthetic witnesses. */
export type RepositoryCreationValidation = Pick<
  Awaited<ReturnType<typeof validateLoadedConfigurationDetailed>>,
  "diagnostics" | "issues"
>;

/** A validated, mutation-free specification for a repository creation. */
export interface RepositoryCreationSpecification {
  readonly template: string;
  readonly ready: boolean;
  readonly constraints?: EffectiveRepositorySelectorConstraints;
  readonly choices?: EffectiveRepositorySelectorChoices;
  readonly repository?: RepositoryMetadata;
  readonly diagnostics: readonly RepositoryCreationDiagnostic[];
  readonly validation: RepositoryCreationValidation;
}

/** Resolve and validate all choices needed to create one repository. */
export async function preflightRepositoryCreation(
  loaded: LoadedConfiguration,
  input: RepositoryCreationInput,
): Promise<RepositoryCreationSpecification> {
  const identity = input.template.startsWith("repository:")
    ? input.template
    : "repository:" + input.template;
  const validation = await validateLoadedConfigurationDetailed(
    loaded,
    identity,
  );
  const semanticValidation: RepositoryCreationValidation = {
    diagnostics: validation.diagnostics,
    issues: validation.issues,
  };
  const diagnostics: RepositoryCreationDiagnostic[] = validation.issues.map(
    (issue) => ({
      code: issue.code,
      message: issue.message,
      template: identity,
      ...(issue.templates !== undefined && { templates: issue.templates }),
      ...(issue.path !== undefined && { path: issue.path }),
      validationIssue: issue,
    }),
  );

  let resolvedIdentity: string;
  try {
    resolvedIdentity = resolveTemplateIdentity(loaded, input.template);
  } catch (error) {
    if (!diagnostics.some((issue) => issue.code === "unknown_template")) {
      diagnostics.push({
        code: "unknown_template",
        message: error instanceof Error ? error.message : String(error),
        template: identity,
      });
    }
    return {
      template: identity,
      ready: false,
      diagnostics,
      validation: semanticValidation,
    };
  }

  const template = loaded.templates[resolvedIdentity];
  const intersection = effectiveRepositorySelectorIntersection(
    loaded.configuration.repositories.scope,
    template,
    resolvedIdentity,
  );
  if (!intersection.reachable || intersection.effective === undefined) {
    return {
      template: resolvedIdentity,
      ready: false,
      constraints: intersection.constraints,
      diagnostics,
      validation: semanticValidation,
    };
  }

  const choices = intersection.effective;
  let name = input.name;
  if (name === undefined) {
    diagnostics.push({
      code: "name_required",
      message: "A repository name must be provided explicitly",
      template: resolvedIdentity,
    });
  } else {
    const nameError = validateRepositoryName(name);
    if (nameError !== undefined) {
      diagnostics.push({
        code: "invalid_name",
        message: nameError,
        template: resolvedIdentity,
        path: "name",
      });
      name = undefined;
    }
  }

  const properties = { ...choices.requiredProperties };
  let propertiesValid = true;
  for (const [property, value] of Object.entries(input.properties ?? {})) {
    const required = choices.requiredProperties[property];
    if (required !== undefined && !propertyValuesEqual(required, value)) {
      propertiesValid = false;
      diagnostics.push({
        code: "property_conflict",
        message: "Property " + property +
          " conflicts with the effective selector requirement",
        template: resolvedIdentity,
        path: "properties." + property,
      });
      continue;
    }
    properties[property] = value;
  }

  const teams = [
    ...new Set([...choices.requiredTeams, ...(input.teams ?? [])]),
  ].sort();
  const visibilityChoices = choices.visibility;
  const constructibleVisibilities = name === undefined || !propertiesValid
    ? visibilityChoices
    : visibilityChoices.filter((candidateVisibility) =>
      matchesEffectiveRepositorySelectorIntersection(intersection, {
        name,
        teams,
        visibility: candidateVisibility,
        properties,
      })
    );
  let visibility = input.visibility;
  if (
    visibility !== undefined &&
    !constructibleVisibilities.includes(visibility)
  ) {
    diagnostics.push({
      code: visibilityChoices.includes(visibility)
        ? "name_outside_intersection"
        : "visibility_not_allowed",
      message: visibilityChoices.includes(visibility)
        ? "Repository metadata does not satisfy all effective include and " +
          "exclude constraints"
        : "Visibility " + visibility +
          " does not satisfy the effective selector constraints",
      template: resolvedIdentity,
      path: "visibility",
    });
    visibility = undefined;
  } else if (
    visibility === undefined && constructibleVisibilities.length === 1
  ) {
    visibility = constructibleVisibilities[0];
  } else if (
    visibility === undefined && constructibleVisibilities.length > 1
  ) {
    diagnostics.push({
      code: "visibility_required",
      message: "Choose a visibility from the allowed values: " +
        constructibleVisibilities.join(", "),
      template: resolvedIdentity,
      path: "visibility",
    });
  } else if (
    visibility === undefined && name !== undefined && propertiesValid
  ) {
    diagnostics.push({
      code: "name_outside_intersection",
      message: "Repository metadata does not satisfy all effective include " +
        "and exclude constraints",
      template: resolvedIdentity,
    });
  }

  let repository: RepositoryMetadata | undefined;
  if (name !== undefined && propertiesValid && visibility !== undefined) {
    const candidate: RepositoryMetadata = {
      name,
      teams,
      visibility,
      properties,
    };
    if (
      matchesEffectiveRepositorySelectorIntersection(intersection, candidate)
    ) {
      const classification = classifyResource(loaded, candidate);
      if (classification.status === "invalid") {
        diagnostics.push({
          code: "template_overlap",
          message: "Repository metadata matches multiple templates: " +
            classification.templates.join(", "),
          template: resolvedIdentity,
          templates: classification.templates,
        });
      } else if (
        classification.status !== "matched" ||
        classification.template !== resolvedIdentity
      ) {
        diagnostics.push({
          code: "template_mismatch",
          message: "Repository metadata does not resolve uniquely to " +
            resolvedIdentity,
          template: resolvedIdentity,
          ...(classification.status === "matched" && {
            templates: [classification.template],
          }),
        });
      } else {
        repository = candidate;
      }
    }
  }

  return {
    template: resolvedIdentity,
    ready: repository !== undefined && diagnostics.length === 0,
    constraints: intersection.constraints,
    choices,
    ...(repository !== undefined && { repository }),
    diagnostics,
    validation: semanticValidation,
  };
}

function validateRepositoryName(name: string): string | undefined {
  if (
    name.length === 0 ||
    name.length > 100 ||
    name.trim() !== name ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    name.includes("..") ||
    name.toLowerCase().endsWith(".git")
  ) {
    return "Repository name must be 1–100 ASCII letters, digits, periods, " +
      "underscores, or hyphens, and must not contain path or wildcard " +
      "characters";
  }
  return undefined;
}

function propertyValuesEqual(
  left: PropertyValue,
  right: PropertyValue,
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => value === right[index]);
  }
  return left === right;
}
