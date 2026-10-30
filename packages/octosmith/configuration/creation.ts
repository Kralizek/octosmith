import type { PropertyValue, RepositoryVisibility } from "../types.ts";
import { equalCustomPropertyValues } from "../state/resources.ts";
import type { LoadedConfiguration } from "./load.ts";
import {
  classifyResource,
  type RepositoryMetadata,
  resolveTemplateIdentity,
} from "./resolve.ts";
import {
  type ConfigurationValidationIssue,
  type ConfigurationValidationIssueCode,
  type EffectiveRepositorySelectorConstraints,
  effectiveRepositorySelectorIntersection,
  matchesEffectiveRepositorySelectorIntersection,
  validateLoadedConfigurationDetailed,
} from "./validate.ts";

const REPOSITORY_VISIBILITIES = ["public", "private", "internal"] as const;
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_NAME_ATTEMPTS = 64;
const MAX_NAME_STRATEGIES = 256;

/** Explicit metadata supplied when preparing a repository creation. */
export interface RepositoryCreationInput {
  readonly template: string;
  readonly name?: string;
  /** Exact effective naming alternative, not an arbitrary generation pattern. */
  readonly namingStrategy?: string;
  readonly visibility?: string;
  readonly teams?: readonly string[];
  readonly properties?: Readonly<Record<string, PropertyValue>>;
}

/** Random byte source for secure, deterministic-testable name generation. */
export type RepositoryCreationRandomSource = (length: number) => Uint8Array;

/** Options for repository creation preflight. */
export interface RepositoryCreationOptions {
  readonly randomBytes?: RepositoryCreationRandomSource;
  readonly maxNameAttempts?: number;
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
  | "ambiguous_name_strategy"
  | "invalid_name_strategy"
  | "name_generation_failed"
  | "metadata_outside_intersection"
  | "invalid_visibility"
  | "visibility_ambiguous"
  | "incompatible_constraints"
  | "property_conflict"
  | "template_mismatch"
  | "template_overlap";

/** Structured name choice available to an assisted creation flow. */
export interface RepositoryCreationNameChoice {
  readonly status:
    | "explicit"
    | "generated"
    | "invalid"
    | "required"
    | "ambiguous"
    | "generation_failed"
    | "unresolved";
  readonly alternatives: readonly { readonly pattern: string }[];
  readonly value?: string;
}

/** Structured visibility choice available to an assisted creation flow. */
export interface RepositoryCreationVisibilityChoice {
  readonly status: "explicit" | "resolved" | "ambiguous" | "invalid";
  readonly alternatives: readonly RepositoryVisibility[];
  readonly value?: RepositoryVisibility;
}

/** All effective choices relevant to constructing a repository. */
export interface RepositoryCreationChoices {
  readonly name: RepositoryCreationNameChoice;
  readonly visibility: RepositoryCreationVisibilityChoice;
  readonly teams: readonly string[];
  readonly customProperties: Readonly<Record<string, PropertyValue>>;
}

/** Semantic validation details without synthetic witnesses. */
export type RepositoryCreationValidation = Pick<
  Awaited<ReturnType<typeof validateLoadedConfigurationDetailed>>,
  "diagnostics" | "issues"
>;

/** A validated, mutation-free specification for a repository creation. */
export interface RepositoryCreationSpecification {
  readonly template: string;
  readonly ready: boolean;
  readonly inputs: RepositoryCreationInput;
  readonly constraints?: EffectiveRepositorySelectorConstraints;
  readonly choices: RepositoryCreationChoices;
  readonly repository?: RepositoryMetadata;
  readonly diagnostics: readonly RepositoryCreationDiagnostic[];
  readonly validation: RepositoryCreationValidation;
}

/** Resolve and validate all choices needed to create one repository. */
export async function preflightRepositoryCreation(
  loaded: LoadedConfiguration,
  input: RepositoryCreationInput,
  options: RepositoryCreationOptions = {},
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
      template: issue.template ?? identity,
      ...(issue.templates !== undefined && { templates: issue.templates }),
      ...(issue.path !== undefined && { path: issue.path }),
      validationIssue: issue,
    }),
  );
  const emptyChoices: RepositoryCreationChoices = {
    name: {
      status: "unresolved",
      alternatives: [],
    },
    visibility: {
      status: "invalid",
      alternatives: [],
    },
    teams: [],
    customProperties: {},
  };

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
      inputs: sanitizeCreationInput(input),
      choices: emptyChoices,
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
      inputs: sanitizeCreationInput(input),
      constraints: intersection.constraints,
      choices: emptyChoices,
      diagnostics,
      validation: semanticValidation,
    };
  }

  const effective = intersection.effective;
  const nameGroups = intersection.constraints.include.map(({ selector }) =>
    selector.names
  ).filter((names): names is readonly string[] => names !== undefined);
  const hasNameConstraints = nameGroups.length > 0;
  const nameStrategyAnalysis = effectiveNameStrategies(nameGroups);
  const nameStrategies = nameStrategyAnalysis.patterns;
  const nameAlternatives = nameStrategies.map((pattern) => ({ pattern }));
  const selectedStrategy = input.namingStrategy;
  const strategyValid = selectedStrategy === undefined ||
    (nameStrategyAnalysis.complete &&
      nameStrategies.includes(selectedStrategy));
  if (!strategyValid) {
    diagnostics.push({
      code: "invalid_name_strategy",
      message:
        "Naming strategy must be a safely resolved effective naming alternative; provide --name if no strategy can be selected",
      template: resolvedIdentity,
      path: "namingStrategy",
    });
  }
  const generationStrategy = strategyValid
    ? selectedStrategy ??
      (nameStrategyAnalysis.complete && nameStrategies.length === 1
        ? nameStrategies[0]
        : undefined)
    : undefined;
  const properties: Record<string, PropertyValue> = {
    ...effective.requiredProperties,
  };
  let propertiesValid = true;
  for (
    const [property, desired] of Object.entries(
      template.repository.customProperties ?? {},
    )
  ) {
    const required = effective.requiredProperties[property];
    if (desired === null) {
      if (required !== undefined) {
        propertiesValid = false;
        diagnostics.push({
          code: "incompatible_constraints",
          message: "Template-managed custom property " + property +
            " removes a value required by the effective selector constraints",
          template: resolvedIdentity,
          path: "repository.customProperties." + property,
        });
      } else {
        delete properties[property];
      }
      continue;
    }
    if (
      required !== undefined &&
      !equalCustomPropertyValues(required, desired)
    ) {
      propertiesValid = false;
      diagnostics.push({
        code: "incompatible_constraints",
        message: "Template-managed custom property " + property +
          " conflicts with the effective selector requirement",
        template: resolvedIdentity,
        path: "repository.customProperties." + property,
      });
    }
    properties[property] = desired;
  }
  for (const [property, value] of Object.entries(input.properties ?? {})) {
    const required = effective.requiredProperties[property];
    if (required !== undefined && !equalCustomPropertyValues(required, value)) {
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
    const desired = template.repository.customProperties?.[property];
    if (
      desired !== undefined &&
      (desired === null || !equalCustomPropertyValues(desired, value))
    ) {
      propertiesValid = false;
      diagnostics.push({
        code: "property_conflict",
        message: "Property " + property +
          " conflicts with the template-managed custom property",
        template: resolvedIdentity,
        path: "properties." + property,
      });
      continue;
    }
    properties[property] = value;
  }

  const teams = [
    ...new Set([
      ...effective.requiredTeams,
      ...(template.repository.teams ?? []).map(({ name }) => name),
      ...(input.teams ?? []),
    ]),
  ].sort();
  const explicitNameIsValid = input.name !== undefined &&
    validateRepositoryName(input.name) === undefined;
  const desiredVisibility = template.repository.settings?.visibility;
  let constructibleVisibilities = [...effective.visibility];
  if (desiredVisibility !== undefined) {
    if (!constructibleVisibilities.includes(desiredVisibility)) {
      diagnostics.push({
        code: "incompatible_constraints",
        message: "Template-managed visibility " + desiredVisibility +
          " conflicts with the effective selector constraints",
        template: resolvedIdentity,
        path: "repository.settings.visibility",
      });
      constructibleVisibilities = [];
    } else {
      constructibleVisibilities = [desiredVisibility];
    }
  }
  if (explicitNameIsValid && propertiesValid) {
    constructibleVisibilities = constructibleVisibilities.filter(
      (candidateVisibility) =>
        matchesEffectiveRepositorySelectorIntersection(intersection, {
          name: input.name!,
          teams,
          visibility: candidateVisibility,
          properties,
        }),
    );
    if (constructibleVisibilities.length === 0) {
      diagnostics.push({
        code: "metadata_outside_intersection",
        message: "Repository name and metadata do not satisfy all effective " +
          "include and exclude constraints",
        template: resolvedIdentity,
        path: "metadata",
      });
    }
  }

  let visibility: RepositoryCreationVisibilityChoice;
  if (
    input.visibility !== undefined &&
    !isRepositoryVisibility(input.visibility)
  ) {
    diagnostics.push({
      code: "invalid_visibility",
      message: "Visibility must be public, private, or internal",
      template: resolvedIdentity,
      path: "visibility",
    });
    visibility = {
      status: "invalid",
      alternatives: constructibleVisibilities,
    };
  } else if (
    input.visibility !== undefined &&
    !constructibleVisibilities.includes(input.visibility)
  ) {
    if (
      !diagnostics.some((issue) =>
        issue.code === "metadata_outside_intersection"
      )
    ) {
      const code = desiredVisibility !== undefined &&
          input.visibility !== desiredVisibility
        ? "incompatible_constraints"
        : "invalid_visibility";
      diagnostics.push({
        code,
        message: code === "incompatible_constraints"
          ? "Explicit visibility conflicts with template-managed visibility " +
            desiredVisibility
          : "Visibility " + input.visibility +
            " does not satisfy the effective selector constraints",
        template: resolvedIdentity,
        path: "visibility",
      });
    }
    visibility = {
      status: "invalid",
      alternatives: constructibleVisibilities,
    };
  } else if (input.visibility !== undefined) {
    visibility = {
      status: "explicit",
      alternatives: constructibleVisibilities,
      value: input.visibility,
    };
  } else if (constructibleVisibilities.length === 1) {
    visibility = {
      status: "resolved",
      alternatives: constructibleVisibilities,
      value: constructibleVisibilities[0],
    };
  } else if (constructibleVisibilities.length > 1) {
    diagnostics.push({
      code: "visibility_ambiguous",
      message: "Choose a visibility with --visibility <" +
        constructibleVisibilities.join("|") +
        "> or use --assisted",
      template: resolvedIdentity,
      path: "visibility",
    });
    visibility = {
      status: "ambiguous",
      alternatives: constructibleVisibilities,
    };
  } else {
    if (
      !diagnostics.some((issue) =>
        issue.code === "incompatible_constraints" ||
        issue.code === "metadata_outside_intersection"
      )
    ) {
      diagnostics.push({
        code: "incompatible_constraints",
        message: "No visibility satisfies the effective selector constraints",
        template: resolvedIdentity,
        path: "visibility",
      });
    }
    visibility = { status: "invalid", alternatives: [] };
  }

  let nameChoice: RepositoryCreationNameChoice;
  if (input.name !== undefined) {
    const nameError = validateRepositoryName(input.name);
    if (nameError !== undefined) {
      diagnostics.push({
        code: "invalid_name",
        message: nameError,
        template: resolvedIdentity,
        path: "name",
      });
      nameChoice = { status: "invalid", alternatives: nameAlternatives };
    } else {
      nameChoice = {
        status: "explicit",
        alternatives: nameAlternatives,
        value: input.name,
      };
    }
  } else if (!strategyValid) {
    nameChoice = { status: "invalid", alternatives: nameAlternatives };
  } else if (
    nameStrategies.length === 0 &&
    !hasNameConstraints
  ) {
    diagnostics.push({
      code: "name_required",
      message: "A repository name is required because the effective selector " +
        "does not define a naming pattern",
      template: resolvedIdentity,
      path: "name",
    });
    nameChoice = { status: "required", alternatives: [] };
  } else if (
    generationStrategy === undefined
  ) {
    // Incomplete analysis must not advertise unproven patterns as selectable.
    const alternatives = nameStrategyAnalysis.complete ? nameAlternatives : [];
    diagnostics.push({
      code: "ambiguous_name_strategy",
      message:
        "Provide --name or select an effective naming strategy with --assisted",
      template: resolvedIdentity,
      path: "name",
    });
    nameChoice = { status: "ambiguous", alternatives };
  } else {
    nameChoice = { status: "unresolved", alternatives: nameAlternatives };
  }

  let repository: RepositoryMetadata | undefined;
  const hasPriorAmbiguity = diagnostics.length > 0;
  if (
    input.name !== undefined &&
    nameChoice.status === "explicit" &&
    visibility.value !== undefined
  ) {
    repository = validateCandidate(input.name);
  } else if (
    input.name === undefined &&
    generationStrategy !== undefined &&
    !hasPriorAmbiguity
  ) {
    const maxAttempts = options.maxNameAttempts ?? DEFAULT_NAME_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxNameAttempts must be a positive integer");
    }
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidateName = generatePatternName(
          generationStrategy,
          options.randomBytes ?? secureRandomBytes,
        );
        if (validateRepositoryName(candidateName) !== undefined) continue;
        repository = validateCandidate(candidateName, false);
        if (repository !== undefined) {
          nameChoice = {
            status: "generated",
            alternatives: nameAlternatives,
            value: candidateName,
          };
          break;
        }
        if (
          diagnostics.some((issue) =>
            issue.code === "template_overlap" ||
            issue.code === "template_mismatch"
          )
        ) {
          break;
        }
      }
    } catch {
      repository = undefined;
    }
    if (
      repository === undefined &&
      !diagnostics.some((issue) =>
        issue.code === "template_overlap" || issue.code === "template_mismatch"
      )
    ) {
      diagnostics.push({
        code: "name_generation_failed",
        message: "Could not generate a valid name from pattern " +
          generationStrategy + " after " + maxAttempts +
          " attempts; provide --name or adjust the selector constraints",
        template: resolvedIdentity,
        path: "name",
      });
      nameChoice = {
        status: "generation_failed",
        alternatives: nameAlternatives,
      };
    }
  }

  const choices: RepositoryCreationChoices = {
    name: nameChoice,
    visibility,
    teams,
    customProperties: properties,
  };

  return {
    template: resolvedIdentity,
    ready: repository !== undefined && diagnostics.length === 0,
    inputs: sanitizeCreationInput(input),
    constraints: intersection.constraints,
    choices,
    ...(repository !== undefined && { repository }),
    diagnostics,
    validation: semanticValidation,
  };

  function validateCandidate(
    name: string,
    reportFailure = true,
  ): RepositoryMetadata | undefined {
    const candidateVisibility = visibility.value;
    if (candidateVisibility === undefined || !propertiesValid) return undefined;
    const candidate: RepositoryMetadata = {
      name,
      teams,
      visibility: candidateVisibility,
      properties,
    };
    if (
      !matchesEffectiveRepositorySelectorIntersection(intersection, candidate)
    ) {
      if (
        reportFailure &&
        !diagnostics.some((issue) =>
          issue.code === "metadata_outside_intersection"
        )
      ) {
        diagnostics.push({
          code: "metadata_outside_intersection",
          message: "Repository metadata does not satisfy all effective " +
            "include and exclude constraints",
          template: resolvedIdentity,
          path: "metadata",
        });
      }
      return undefined;
    }

    const classification = classifyResource(loaded, candidate);
    if (classification.status === "invalid") {
      if (
        !diagnostics.some((issue) => issue.code === "template_overlap")
      ) {
        diagnostics.push({
          code: "template_overlap",
          message: "Repository metadata matches multiple templates: " +
            classification.templates.join(", "),
          template: resolvedIdentity,
          templates: classification.templates,
          path: "name",
        });
      }
      return undefined;
    }
    if (
      classification.status !== "matched" ||
      classification.template !== resolvedIdentity
    ) {
      if (
        !diagnostics.some((issue) => issue.code === "template_mismatch")
      ) {
        diagnostics.push({
          code: "template_mismatch",
          message: "Repository metadata does not resolve uniquely to " +
            resolvedIdentity,
          template: resolvedIdentity,
          ...(classification.status === "matched" && {
            templates: [classification.template],
          }),
          path: "name",
        });
      }
      return undefined;
    }
    return candidate;
  }
}

function sanitizeCreationInput(
  input: RepositoryCreationInput,
): RepositoryCreationInput {
  return {
    template: input.template,
    ...(input.name !== undefined && { name: input.name }),
    ...(input.namingStrategy !== undefined &&
      { namingStrategy: input.namingStrategy }),
    ...(input.visibility !== undefined && { visibility: input.visibility }),
    ...(input.teams !== undefined && { teams: input.teams }),
    ...(input.properties !== undefined && { properties: input.properties }),
  };
}

function effectiveNameStrategies(
  groups: readonly (readonly string[])[],
): { readonly patterns: readonly string[]; readonly complete: boolean } {
  if (groups.length === 0) return { patterns: [], complete: true };
  const results = new Set<string>();
  let combinations = 0;
  let complete = true;
  const selected: string[] = [];

  const visit = (index: number): void => {
    if (results.size >= MAX_NAME_STRATEGIES) {
      complete = false;
      return;
    }
    if (index === groups.length) {
      combinations++;
      if (combinations > MAX_NAME_STRATEGIES) {
        complete = false;
        return;
      }
      for (const candidate of selected) {
        if (
          selected.every((pattern) => globLanguageSubset(candidate, pattern))
        ) {
          results.add(candidate);
        }
      }
      return;
    }
    for (const pattern of groups[index]) {
      selected.push(pattern);
      visit(index + 1);
      selected.pop();
      if (combinations > MAX_NAME_STRATEGIES) {
        complete = false;
        return;
      }
    }
  };

  visit(0);
  return { patterns: [...results].sort(), complete };
}

function globLanguageSubset(left: string, right: string): boolean {
  const alphabet = new Set<string>();
  for (const character of left + right) {
    if (character !== "*" && character !== "?") alphabet.add(character);
  }
  let sentinel = "\u0000";
  while (alphabet.has(sentinel)) sentinel += "\u0000";
  alphabet.add(sentinel);

  const startLeft = globClosure(left, [0]);
  const startRight = globClosure(right, [0]);
  const queue: Array<{ left: readonly number[]; right: readonly number[] }> = [
    { left: startLeft, right: startRight },
  ];
  const visited = new Set<string>();

  for (let index = 0; index < queue.length; index++) {
    const state = queue[index];
    const key = state.left.join(",") + "|" + state.right.join(",");
    if (visited.has(key)) continue;
    visited.add(key);
    if (
      state.left.includes(left.length) &&
      !state.right.includes(right.length)
    ) return false;

    for (const character of alphabet) {
      queue.push({
        left: globStep(left, state.left, character),
        right: globStep(right, state.right, character),
      });
    }
  }
  return true;
}

function globClosure(pattern: string, positions: readonly number[]): number[] {
  const result = new Set(positions);
  const queue = [...positions];
  while (queue.length > 0) {
    const position = queue.pop()!;
    if (pattern[position] === "*" && !result.has(position + 1)) {
      result.add(position + 1);
      queue.push(position + 1);
    }
  }
  return [...result].sort((left, right) => left - right);
}

function globStep(
  pattern: string,
  positions: readonly number[],
  character: string,
): number[] {
  const next = new Set<number>();
  for (const position of positions) {
    const token = pattern[position];
    if (token === "*") next.add(position);
    else if (token === "?" || token === character) next.add(position + 1);
  }
  return globClosure(pattern, [...next]);
}

function generatePatternName(
  pattern: string,
  randomBytes: RepositoryCreationRandomSource,
): string {
  return pattern.replace(
    /[*?]/g,
    (token) =>
      token === "*"
        ? randomCharacters(6, randomBytes)
        : randomCharacters(1, randomBytes),
  );
}

function randomCharacters(
  length: number,
  randomBytes: RepositoryCreationRandomSource,
): string {
  let value = "";
  while (value.length < length) {
    const requested = length - value.length;
    const bytes = randomBytes(requested);
    if (!(bytes instanceof Uint8Array) || bytes.length < requested) {
      throw new Error("Random byte source returned too few bytes");
    }
    for (const byte of bytes) {
      if (byte >= 252) continue;
      value += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
      if (value.length === length) break;
    }
  }
  return value;
}

function secureRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
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

function isRepositoryVisibility(value: string): value is RepositoryVisibility {
  return REPOSITORY_VISIBILITIES.includes(value as RepositoryVisibility);
}
