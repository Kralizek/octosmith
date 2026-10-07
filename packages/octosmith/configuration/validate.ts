import {
  buildPlan,
  type CurrentState,
  loadConfigurationDirectory,
  type LoadedConfiguration,
  matchesSelector,
  type PropertyValue,
  type RepositoryMetadata,
  type RepositorySelector,
  type RepositoryTemplate,
  resolveDesiredState,
  type RuntimeReferenceDiagnostic,
  runtimeReferenceWarnings,
  type Scope,
} from "../mod.ts";
import { loadConfigurationDirectoryCollectingIssues } from "./load.ts";

/**
 * Validate a configuration directory without consulting GitHub.
 *
 * This loads the configuration and templates, performs static selector
 * compatibility checks, resolves each template against synthetic metadata that
 * satisfies its selector, reads referenced local files, and exercises planner
 * invariants against an empty current state.
 */
export async function validateConfigurationDirectory(
  root: string,
): Promise<readonly RuntimeReferenceDiagnostic[]> {
  return await validateLoadedConfiguration(
    await loadConfigurationDirectory(root),
  );
}

/** Stable identifiers for semantic configuration validation problems. */
export type ConfigurationValidationIssueCode =
  | "configuration_load_error"
  | "template_load_error"
  | "unknown_template"
  | "template_unreachable"
  | "template_overlap"
  | "scope_repository_unmatched"
  | "scope_without_reachable_templates"
  | "planner_invariant";

/** Describes one independently detected semantic validation problem. */
export interface ConfigurationValidationIssue {
  readonly code: ConfigurationValidationIssueCode;
  readonly message: string;
  readonly template?: string;
  readonly templates?: readonly string[];
  readonly path?: string;
  readonly constraints?: EffectiveRepositorySelectorConstraints;
}

/** Describes the complete semantic validation result for a loaded configuration. */
export interface ConfigurationValidationResult {
  readonly diagnostics: readonly RuntimeReferenceDiagnostic[];
  readonly issues: readonly ConfigurationValidationIssue[];
  readonly intersections: readonly EffectiveRepositorySelectorIntersection[];
}

/** Validate a configuration directory and return all independently detectable issues. */
export async function validateConfigurationDirectoryDetailed(
  root: string,
  isSecretAvailable?: (name: string) => boolean,
): Promise<ConfigurationValidationResult> {
  return await validateDirectoryDetailed(root, undefined, isSecretAvailable);
}

/** Validate one selected template and its containing configuration. */
export async function validateTemplateDirectoryDetailed(
  root: string,
  template: string,
  isSecretAvailable?: (name: string) => boolean,
): Promise<ConfigurationValidationResult> {
  return await validateDirectoryDetailed(root, template, isSecretAvailable);
}

async function validateDirectoryDetailed(
  root: string,
  selectedTemplate: string | undefined,
  isSecretAvailable: ((name: string) => boolean) | undefined,
): Promise<ConfigurationValidationResult> {
  let loading;
  try {
    loading = await loadConfigurationDirectoryCollectingIssues(
      root,
    );
  } catch (error) {
    return {
      diagnostics: [],
      issues: [{
        code: "configuration_load_error",
        message: error instanceof Error ? error.message : String(error),
        path: "configuration",
      }],
      intersections: [],
    };
  }
  const validation = await collectLoadedConfigurationValidation(
    loading.loaded,
    selectedTemplate,
    loading.issues.length === 0,
    isSecretAvailable,
    true,
    true,
  );
  const selectedIdentity = selectedTemplate === undefined
    ? undefined
    : selectedTemplate.startsWith("repository:")
    ? selectedTemplate
    : "repository:" + selectedTemplate;
  const loadIssues = loading.issues
    .filter((issue) =>
      selectedIdentity === undefined || issue.template === selectedIdentity
    )
    .map((issue) => ({
      code: issue.code,
      message: issue.message,
      template: issue.template,
      path: issue.path,
    }));
  const issues = validation.issues.filter((issue) =>
    issue.code !== "unknown_template" ||
    !loadIssues.some((loadIssue) => loadIssue.template === issue.template)
  );
  return {
    diagnostics: validation.diagnostics,
    issues: [...loadIssues, ...issues],
    intersections: validation.intersections,
  };
}

/** Identifies one effective selector constraint and its configuration path. */
export interface EffectiveRepositorySelectorConstraint {
  readonly path: string;
  readonly selector: RepositorySelector;
}

/** Exact positive and negative constraints for a scope/template intersection. */
export interface EffectiveRepositorySelectorConstraints {
  readonly include: readonly EffectiveRepositorySelectorConstraint[];
  readonly exclude: readonly EffectiveRepositorySelectorConstraint[];
}

/** The constructible repository constraints shared by scope and template. */
export interface EffectiveRepositorySelectorIntersection {
  readonly template: string;
  readonly reachable: boolean;
  readonly constraints: EffectiveRepositorySelectorConstraints;
  readonly witness?: RepositoryMetadata;
}

async function collectLoadedConfigurationValidation(
  loaded: LoadedConfiguration,
  selectedTemplate?: string,
  templateSetComplete = true,
  isSecretAvailable?: (name: string) => boolean,
  reportUnreachableTemplates = false,
  validateRootScopeCoverage = false,
): Promise<ConfigurationValidationResult> {
  const diagnostics: RuntimeReferenceDiagnostic[] = [];
  const issues: ConfigurationValidationIssue[] = [];
  const intersections: EffectiveRepositorySelectorIntersection[] = [];

  const scope = loaded.configuration.repositories.scope;
  if (selectedTemplate === undefined) {
    issues.push(...findTemplateOverlapIssues(scope, loaded.templates));
  }
  if (
    (selectedTemplate === undefined || validateRootScopeCoverage) &&
    templateSetComplete &&
    loaded.configuration.repositories.settings?.unmatchedRepositories !==
      "ignore"
  ) {
    issues.push(...findScopeCoverageIssues(scope, loaded.templates));
  }

  const selectedIdentity = selectedTemplate === undefined
    ? undefined
    : selectedTemplate.startsWith("repository:")
    ? selectedTemplate
    : "repository:" + selectedTemplate;
  if (
    selectedIdentity !== undefined &&
    loaded.templates[selectedIdentity] === undefined
  ) {
    issues.push({
      code: "unknown_template",
      message: "Unknown template: " + selectedTemplate,
      template: selectedIdentity,
      path: "templates." + selectedIdentity,
    });
    return { diagnostics, issues, intersections };
  }

  for (const [name, template] of Object.entries(loaded.templates)) {
    if (selectedIdentity !== undefined && name !== selectedIdentity) continue;
    diagnostics.push(
      ...runtimeReferenceWarnings(
        name,
        template,
        isSecretAvailable,
      ),
    );
    const intersection = effectiveRepositorySelectorIntersection(
      scope,
      template,
      name,
    );
    intersections.push(intersection);
    const repository = intersection.witness;

    if (repository === undefined) {
      if (selectedIdentity !== undefined || reportUnreachableTemplates) {
        issues.push({
          code: "template_unreachable",
          message: "Template " + (selectedTemplate ?? name) +
            " cannot match any repository within configured scope",
          template: name,
          path: "repositories.scope.intersection." + name + ".match",
          constraints: intersection.constraints,
        });
      }
      continue;
    }

    try {
      const configuration: LoadedConfiguration = {
        ...loaded,
        templates: { [name]: template },
      };
      const desired = await resolveDesiredState(
        configuration,
        repository,
        (value) => "validation:" + value,
      );

      buildPlan(emptyCurrentState(repository.name), desired);
    } catch (error) {
      issues.push({
        code: "planner_invariant",
        message: error instanceof Error ? error.message : String(error),
        template: name,
        path: "templates." + name,
      });
    }
  }

  return { diagnostics, issues, intersections };
}

/** Validate a loaded configuration and retain all structured semantic results. */
export async function validateLoadedConfigurationDetailed(
  loaded: LoadedConfiguration,
  selectedTemplate?: string,
): Promise<ConfigurationValidationResult> {
  return await collectLoadedConfigurationValidation(
    loaded,
    selectedTemplate,
    true,
    undefined,
    true,
    true,
  );
}

/** Validate a loaded configuration using the same semantic checks as directory validation. */
export async function validateLoadedConfiguration(
  loaded: LoadedConfiguration,
  selectedTemplate?: string,
): Promise<readonly RuntimeReferenceDiagnostic[]> {
  const result = await collectLoadedConfigurationValidation(
    loaded,
    selectedTemplate,
  );
  if (result.issues.length > 0) {
    throw new Error(result.issues[0].message);
  }
  return result.diagnostics;
}

/** Whether a template can manage a repository within the configured scope. */
export function templateCanMatchScope(
  scope: Scope<RepositorySelector>,
  template: RepositoryTemplate,
): boolean {
  return effectiveRepositorySelectorIntersection(
    scope,
    template,
    "repository:template",
  ).reachable;
}

/** Expose exact include/exclude constraints and a witness for a template in scope. */
export function effectiveRepositorySelectorIntersection(
  scope: Scope<RepositorySelector>,
  template: RepositoryTemplate,
  templateIdentity: string,
): EffectiveRepositorySelectorIntersection {
  const include = [
    {
      path: "repositories.scope.include",
      selector: scope.include === "all" ? {} : scope.include,
    },
    {
      path: "templates." + templateIdentity + ".match.include",
      selector: template.match.include === "all" ? {} : template.match.include,
    },
  ];
  const exclude = [
    scope.exclude === undefined
      ? undefined
      : { path: "repositories.scope.exclude", selector: scope.exclude },
    template.match.exclude === undefined ? undefined : {
      path: "templates." + templateIdentity + ".match.exclude",
      selector: template.match.exclude,
    },
  ].filter((constraint) => constraint !== undefined);
  const witness = scopeIntersectionWitness(
    include.map((constraint) => constraint.selector),
    exclude.map((constraint) => constraint.selector),
    templateIdentity,
  );

  return {
    template: templateIdentity,
    reachable: witness !== undefined,
    constraints: { include, exclude },
    witness,
  };
}

function findTemplateOverlapIssues(
  scope: Scope<RepositorySelector>,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): readonly ConfigurationValidationIssue[] {
  const issues: ConfigurationValidationIssue[] = [];
  const entries = Object.entries(templates);
  const scopeInclude = scope.include === "all" ? {} : scope.include;

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    const [leftName, left] = entries[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < entries.length;
      rightIndex++
    ) {
      const [rightName, right] = entries[rightIndex];
      const leftInclude = left.match.include === "all"
        ? {}
        : left.match.include;
      const rightInclude = right.match.include === "all"
        ? {}
        : right.match.include;

      if (
        scopeIntersectionWitness(
          [scopeInclude, leftInclude, rightInclude],
          [
            scope.exclude,
            left.match.exclude,
            right.match.exclude,
          ].filter(
            (selector): selector is RepositorySelector =>
              selector !== undefined,
          ),
          leftName + "-" + rightName,
        ) !== undefined
      ) {
        issues.push({
          code: "template_overlap",
          message:
            "Repository templates can overlap within configured scope: " +
            leftName + ", " + rightName,
          templates: [leftName, rightName],
          path: "repositories.scope",
          constraints: {
            include: [
              { path: "repositories.scope.include", selector: scopeInclude },
              {
                path: "templates." + leftName + ".match.include",
                selector: leftInclude,
              },
              {
                path: "templates." + rightName + ".match.include",
                selector: rightInclude,
              },
            ],
            exclude: [
              scope.exclude === undefined ? undefined : {
                path: "repositories.scope.exclude",
                selector: scope.exclude,
              },
              left.match.exclude === undefined ? undefined : {
                path: "templates." + leftName + ".match.exclude",
                selector: left.match.exclude,
              },
              right.match.exclude === undefined ? undefined : {
                path: "templates." + rightName + ".match.exclude",
                selector: right.match.exclude,
              },
            ].filter((constraint) => constraint !== undefined),
          },
        });
      }
    }
  }

  return issues;
}

function findScopeCoverageIssues(
  scope: Scope<RepositorySelector>,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): readonly ConfigurationValidationIssue[] {
  const issues: ConfigurationValidationIssue[] = [];
  const scopeInclude = scope.include === "all" ? {} : scope.include;
  const entries = Object.entries(templates);

  for (const name of scopeInclude.names ?? []) {
    if (name.includes("*") || name.includes("?")) {
      continue;
    }

    const literalName: RepositorySelector = { names: [name] };
    const possible = entries.some(([templateName, template]) => {
      const templateInclude = template.match.include === "all"
        ? {}
        : template.match.include;

      return scopeIntersectionWitness(
        [scopeInclude, literalName, templateInclude],
        [
          scope.exclude,
          template.match.exclude,
        ].filter(
          (selector): selector is RepositorySelector => selector !== undefined,
        ),
        templateName,
      ) !== undefined;
    });

    if (!possible) {
      issues.push({
        code: "scope_repository_unmatched",
        message: "Repository " + name +
          " cannot match any template within configured scope",
        path: "repositories.scope.include.names",
        constraints: {
          include: [
            { path: "repositories.scope.include", selector: scopeInclude },
            { path: "repositories.scope.include.names", selector: literalName },
          ],
          exclude: scope.exclude === undefined
            ? []
            : [{ path: "repositories.scope.exclude", selector: scope.exclude }],
        },
      });
    }
  }

  const anyTemplateReachable = entries.some(([templateName, template]) => {
    const templateInclude = template.match.include === "all"
      ? {}
      : template.match.include;

    return scopeIntersectionWitness(
      [scopeInclude, templateInclude],
      [
        scope.exclude,
        template.match.exclude,
      ].filter(
        (selector): selector is RepositorySelector => selector !== undefined,
      ),
      templateName,
    ) !== undefined;
  });

  if (!anyTemplateReachable) {
    issues.push({
      code: "scope_without_reachable_templates",
      message: "Configured repository scope cannot match any template",
      path: "repositories.scope",
      constraints: {
        include: [{
          path: "repositories.scope.include",
          selector: scopeInclude,
        }],
        exclude: scope.exclude === undefined
          ? []
          : [{ path: "repositories.scope.exclude", selector: scope.exclude }],
      },
    });
  }

  return issues;
}

function scopeIntersectionWitness(
  positiveSelectors: readonly RepositorySelector[],
  negativeSelectors: readonly RepositorySelector[],
  fallbackName: string,
): RepositoryMetadata | undefined {
  if (!selectorsCanOverlap(...positiveSelectors)) {
    return undefined;
  }

  const properties = mergeProperties(
    positiveSelectors.map((selector) => selector.properties),
  );
  const teams = [
    ...new Set(
      positiveSelectors.flatMap((selector) => selector.teams ?? []),
    ),
  ];
  const visibilityCandidates = visibilityIntersectionCandidates(
    positiveSelectors.map((selector) => selector.visibility),
  );

  for (const visibility of visibilityCandidates) {
    const base: RepositoryMetadata = {
      name: "",
      teams,
      visibility,
      properties,
    };
    const blockedByNamelessSelector = negativeSelectors.some((selector) =>
      selector.names === undefined && matchesSelector(selector, base)
    );

    if (blockedByNamelessSelector) {
      continue;
    }

    const activeNegativeNameSelectors = negativeSelectors
      .filter((selector) =>
        selector.names !== undefined &&
        matchesSelector({ ...selector, names: undefined }, base)
      )
      .map((selector) => selector.names)
      .filter((names): names is readonly string[] => names !== undefined);

    const name = nameConstraintWitness(
      positiveSelectors.map((selector) => selector.names),
      activeNegativeNameSelectors,
    ) ?? (
      positiveSelectors.every((selector) => selector.names === undefined) &&
        activeNegativeNameSelectors.length === 0
        ? "validation-" + fallbackName
        : undefined
    );

    if (name !== undefined) {
      return { ...base, name };
    }
  }

  return undefined;
}

function visibilityIntersectionCandidates(
  selectors: readonly RepositorySelector["visibility"][],
): readonly ("public" | "private" | "internal")[] {
  const constrained = selectors.filter(
    (visibility): visibility is Exclude<
      RepositorySelector["visibility"],
      undefined
    > => visibility !== undefined,
  );

  if (constrained.length === 0) {
    return ["public", "private", "internal"];
  }

  return ["public", "private", "internal"].filter((candidate) =>
    constrained.every((visibility) => {
      const allowed = Array.isArray(visibility) ? visibility : [visibility];
      return allowed.includes(candidate);
    })
  ) as readonly ("public" | "private" | "internal")[];
}

function nameConstraintWitness(
  positiveSelectors: readonly (readonly string[] | undefined)[],
  negativeSelectors: readonly (readonly string[])[],
): string | undefined {
  const positiveGroups = positiveSelectors.filter(
    (names): names is readonly string[] => names !== undefined,
  );

  const patternGroups = [...positiveGroups, ...negativeSelectors];
  const patterns = patternGroups.flatMap((group) => group);
  const groupOffsets: number[] = [];
  let offset = 0;
  for (const group of patternGroups) {
    groupOffsets.push(offset);
    offset += group.length;
  }

  const alphabet = globAlphabet(patterns);
  const initial = patterns.map((pattern) => globEpsilonClosure(pattern, [0]));
  const queue: Array<{
    readonly states: readonly (readonly number[])[];
    readonly value: string;
  }> = [{ states: initial, value: "" }];
  const visited = new Set<string>();
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex++]!;
    const key = current.states.map((state) => state.join(",")).join("|") +
      ":" + (current.value.length > 0 ? "non-empty" : "empty");
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    const groupMatches = patternGroups.map((group, groupIndex) => {
      const start = groupOffsets[groupIndex];
      return group.some((pattern, patternIndex) =>
        current.states[start + patternIndex].includes(pattern.length)
      );
    });

    const positiveMatches = groupMatches
      .slice(0, positiveGroups.length)
      .every(Boolean);
    const negativeMatches = groupMatches
      .slice(positiveGroups.length)
      .some(Boolean);

    if (positiveMatches && !negativeMatches && current.value.length > 0) {
      return current.value;
    }

    for (const character of alphabet) {
      const nextStates = patterns.map((pattern, index) =>
        globTransition(pattern, current.states[index], character)
      );
      if (nextStates.every((state) => state.length === 0)) {
        if (positiveGroups.length === 0) {
          return current.value + character;
        }
        continue;
      }
      queue.push({
        states: nextStates,
        value: current.value + character,
      });
    }
  }

  return undefined;
}

function globAlphabet(patterns: readonly string[]): readonly string[] {
  const literals = new Set<string>();
  for (const pattern of patterns) {
    for (const character of pattern) {
      if (character !== "*" && character !== "?") {
        literals.add(character);
      }
    }
  }

  for (let codePoint = 0xE000; codePoint <= 0xF8FF; codePoint++) {
    const other = String.fromCharCode(codePoint);
    if (!literals.has(other)) {
      return [...literals, other];
    }
  }

  throw new Error("Exhausted glob wildcard sentinel space");
}

function globEpsilonClosure(
  pattern: string,
  positions: readonly number[],
): readonly number[] {
  const result = new Set(positions);
  const queue = [...positions];

  while (queue.length > 0) {
    const position = queue.shift()!;
    if (pattern[position] === "*" && !result.has(position + 1)) {
      result.add(position + 1);
      queue.push(position + 1);
    }
  }

  return [...result].sort((left, right) => left - right);
}

function globTransition(
  pattern: string,
  state: readonly number[],
  character: string,
): readonly number[] {
  const next = new Set<number>();

  for (const position of state) {
    const token = pattern[position];
    if (token === "*") {
      next.add(position);
    } else if (token === "?" || token === character) {
      next.add(position + 1);
    }
  }

  return globEpsilonClosure(pattern, [...next]);
}

function selectorsCanOverlap(
  ...selectors: readonly RepositorySelector[]
): boolean {
  if (!nameSelectorsCanOverlap(selectors.map((selector) => selector.names))) {
    return false;
  }

  if (
    !visibilityCanOverlap(selectors.map((selector) => selector.visibility))
  ) {
    return false;
  }

  if (
    !propertiesCanOverlap(selectors.map((selector) => selector.properties))
  ) {
    return false;
  }

  // Team selectors are conjunctions. A repository can satisfy all selectors by
  // belonging to the union of every required team set.
  return true;
}

function nameSelectorsCanOverlap(
  selectors: readonly (readonly string[] | undefined)[],
): boolean {
  const constrained = selectors.filter(
    (names): names is readonly string[] => names !== undefined,
  );

  if (constrained.length === 0) {
    return true;
  }

  return globChoiceCanOverlap(constrained, 0, []);
}

function globChoiceCanOverlap(
  choices: readonly (readonly string[])[],
  index: number,
  selected: readonly string[],
): boolean {
  if (index === choices.length) {
    return globPatternsCanOverlap(...selected);
  }

  return choices[index].some((pattern) =>
    globChoiceCanOverlap(choices, index + 1, [...selected, pattern])
  );
}

function visibilityCanOverlap(
  selectors: readonly RepositorySelector["visibility"][],
): boolean {
  const candidates = new Set(["public", "private", "internal"] as const);

  for (const visibility of selectors) {
    if (visibility === undefined) {
      continue;
    }

    const allowed = Array.isArray(visibility) ? visibility : [visibility];
    for (const candidate of [...candidates]) {
      if (!allowed.includes(candidate)) {
        candidates.delete(candidate);
      }
    }
  }

  return candidates.size > 0;
}

function propertiesCanOverlap(
  selectors: readonly (
    Readonly<Record<string, PropertyValue>> | undefined
  )[],
): boolean {
  const required = new Map<string, PropertyValue>();

  for (const properties of selectors) {
    if (properties === undefined) {
      continue;
    }

    for (const [name, value] of Object.entries(properties)) {
      const existing = required.get(name);
      if (existing !== undefined && !equalPropertyValue(existing, value)) {
        return false;
      }
      required.set(name, value);
    }
  }

  return true;
}

function equalPropertyValue(
  left: PropertyValue,
  right: PropertyValue,
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => value === right[index]);
  }

  return left === right;
}

function globPatternsCanOverlap(...patterns: readonly string[]): boolean {
  return globPatternsIntersectionWitness(...patterns) !== undefined;
}

function globPatternsIntersectionWitness(
  ...patterns: readonly string[]
): string | undefined {
  const initial = patterns.map(() => 0);
  const queue: Array<{ readonly positions: number[]; readonly value: string }> =
    [
      { positions: initial, value: "" },
    ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { positions, value } = queue.shift()!;
    const key = positions.join(":");

    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    if (
      positions.every((position, index) => position === patterns[index].length)
    ) {
      return value;
    }

    for (let index = 0; index < patterns.length; index++) {
      if (patterns[index][positions[index]] === "*") {
        const advanced = [...positions];
        advanced[index]++;
        queue.push({ positions: advanced, value });
      }
    }

    const tokens = patterns.map((pattern, index) =>
      consumingToken(pattern, positions[index])
    );

    if (
      tokens.every((token) => token !== undefined) &&
      tokensCanMatchSameCharacter(
        ...tokens.map((token) => token!.token),
      )
    ) {
      const literals = tokens
        .map((token) => token!.token)
        .filter((token): token is string => token !== null);
      queue.push({
        positions: tokens.map((token) => token!.next),
        value: value + (literals[0] ?? "x"),
      });
    }
  }

  return undefined;
}

function consumingToken(
  pattern: string,
  index: number,
): { readonly token: string | null; readonly next: number } | undefined {
  const token = pattern[index];

  if (token === undefined) {
    return undefined;
  }

  if (token === "*") {
    return { token: null, next: index };
  }

  if (token === "?") {
    return { token: null, next: index + 1 };
  }

  return { token, next: index + 1 };
}

function tokensCanMatchSameCharacter(
  ...tokens: readonly (string | null)[]
): boolean {
  const literals = tokens.filter((token): token is string => token !== null);
  return literals.length === 0 ||
    literals.every((token) => token === literals[0]);
}
function mergeProperties(
  selectors: readonly (
    Readonly<Record<string, PropertyValue>> | undefined
  )[],
): Readonly<Record<string, PropertyValue>> {
  const result: Record<string, PropertyValue> = {};

  for (const properties of selectors) {
    if (properties === undefined) {
      continue;
    }
    Object.assign(result, properties);
  }

  return result;
}

function emptyCurrentState(repository: string): CurrentState {
  return {
    repository,
    settings: {
      name: repository,
      description: null,
      website: null,
      topics: [],
      visibility: "private",
      hasIssues: false,
      hasProjects: false,
      hasWiki: false,
      hasDiscussions: false,
      hasPullRequests: true,
      pullRequestCreationPolicy: "all",
      isTemplate: false,
      defaultBranch: "main",
      merge: {
        allowSquashMerge: true,
        allowMergeCommit: true,
        allowRebaseMerge: true,
        allowAutoMerge: false,
        allowUpdateBranch: false,
        deleteBranchOnMerge: false,
        squashMergeCommitTitle: "pull-request-title",
        squashMergeCommitMessage: "pull-request-body",
        mergeCommitTitle: "pull-request-title",
        mergeCommitMessage: "pull-request-title",
      },
      archived: false,
      allowForking: false,
      webCommitSignoffRequired: false,
      securityAndAnalysis: {},
    },
    customProperties: {},
    actions: {
      enabled: true,
      allowedActions: "all",
      shaPinningRequired: false,
      oidc: {
        subjectClaimTemplate: { source: "default" },
        immutableSubject: false,
      },
      secrets: [],
      variables: [],
    },
    dependabot: { secrets: [] },
    teams: [],
    rulesets: [],
    environments: [],
    files: [],
  };
}
