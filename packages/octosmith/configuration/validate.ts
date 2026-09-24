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
  const loaded = await loadConfigurationDirectory(root);
  const diagnostics: RuntimeReferenceDiagnostic[] = [];

  const scope = loaded.configuration.repositories.scope;
  assertTemplatesDoNotOverlap(scope, loaded.templates);
  if (
    loaded.configuration.repositories.settings?.unmatchedRepositories !==
      "ignore"
  ) {
    assertScopeCanMatchTemplate(scope, loaded.templates);
  }

  for (const [name, template] of Object.entries(loaded.templates)) {
    diagnostics.push(...runtimeReferenceWarnings(name, template));
    const scopeInclude = scope.include === "all" ? {} : scope.include;
    const templateInclude = template.match.include === "all"
      ? {}
      : template.match.include;
    const inScope = selectorsCanOverlap(scopeInclude, templateInclude);
    const repository = repositoryForSelectors(
      name,
      inScope ? [scopeInclude, templateInclude] : [templateInclude],
    );
    const validationTemplate: RepositoryTemplate = {
      ...template,
      match: { include: template.match.include },
    };
    const configuration: LoadedConfiguration = {
      ...loaded,
      templates: { [name]: validationTemplate },
    };
    const desired = await resolveDesiredState(
      configuration,
      repository,
      (value) => "validation:" + value,
    );

    buildPlan(emptyCurrentState(repository.name), desired);
  }

  return diagnostics;
}

function assertTemplatesDoNotOverlap(
  scope: Scope<RepositorySelector>,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): void {
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
        throw new Error(
          "Repository templates can overlap within configured scope: " +
            leftName + ", " + rightName,
        );
      }
    }
  }
}

function assertScopeCanMatchTemplate(
  scope: Scope<RepositorySelector>,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): void {
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
          (selector): selector is RepositorySelector =>
            selector !== undefined,
        ),
        templateName,
      ) !== undefined;
    });

    if (!possible) {
      throw new Error(
        "Repository " + name +
          " cannot match any template within configured scope",
      );
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
        (selector): selector is RepositorySelector =>
          selector !== undefined,
      ),
      templateName,
    ) !== undefined;
  });

  if (!anyTemplateReachable) {
    throw new Error("Configured repository scope cannot match any template");
  }
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
    const activeNegativeNameSelectors = negativeSelectors
      .filter((selector) =>
        matchesSelector({ ...selector, names: undefined }, base)
      )
      .map((selector) => selector.names);

    if (activeNegativeNameSelectors.some((names) => names === undefined)) {
      continue;
    }

    const name = nameConstraintWitness(
      positiveSelectors.map((selector) => selector.names),
      activeNegativeNameSelectors as readonly (readonly string[])[],
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

  if (positiveGroups.length === 0 && negativeSelectors.length === 0) {
    return "";
  }

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

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = current.states.map((state) => state.join(",")).join("|");
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

    if (positiveMatches && !negativeMatches) {
      return current.value;
    }

    for (const character of alphabet) {
      const nextStates = patterns.map((pattern, index) =>
        globTransition(pattern, current.states[index], character)
      );
      if (nextStates.every((state) => state.length === 0)) {
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

  let other = "§";
  while (literals.has(other)) {
    other += "§";
  }

  return [...literals, other];
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

function repositoryForSelectors(
  fallbackName: string,
  selectors: readonly RepositorySelector[],
): RepositoryMetadata {
  const name = nameIntersectionWitness(
    selectors.map((selector) => selector.names),
  ) ?? "validation-" + fallbackName;
  const visibility = visibilityIntersectionWitness(
    selectors.map((selector) => selector.visibility),
  );
  const teams = [
    ...new Set(selectors.flatMap((selector) => selector.teams ?? [])),
  ];
  const properties = mergeProperties(
    selectors.map((selector) => selector.properties),
  );

  return {
    name,
    teams,
    ...(visibility !== undefined && { visibility }),
    properties,
  };
}

function nameIntersectionWitness(
  selectors: readonly (readonly string[] | undefined)[],
): string | undefined {
  const constrained = selectors.filter(
    (names): names is readonly string[] => names !== undefined,
  );

  if (constrained.length === 0) {
    return undefined;
  }

  return globChoiceWitness(constrained, 0, []);
}

function globChoiceWitness(
  choices: readonly (readonly string[])[],
  index: number,
  selected: readonly string[],
): string | undefined {
  if (index === choices.length) {
    return globPatternsIntersectionWitness(...selected);
  }

  for (const pattern of choices[index]) {
    const witness = globChoiceWitness(choices, index + 1, [
      ...selected,
      pattern,
    ]);
    if (witness !== undefined) {
      return witness;
    }
  }

  return undefined;
}

function visibilityIntersectionWitness(
  selectors: readonly RepositorySelector["visibility"][],
): "public" | "private" | "internal" | undefined {
  const candidates = ["public", "private", "internal"] as const;

  return candidates.find((candidate) =>
    selectors.every((visibility) => {
      if (visibility === undefined) {
        return true;
      }
      const allowed = Array.isArray(visibility) ? visibility : [visibility];
      return allowed.includes(candidate);
    })
  );
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
