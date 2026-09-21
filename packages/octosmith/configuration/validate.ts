import {
  buildPlan,
  type CurrentState,
  loadConfigurationDirectory,
  type PropertyValue,
  type RepositoryMetadata,
  type RepositorySelector,
  type RepositoryTemplate,
  resolveDesiredState,
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
): Promise<void> {
  const loaded = await loadConfigurationDirectory(root);

  const scope = loaded.configuration.repositories.scope;
  assertTemplatesDoNotOverlap(scope, loaded.templates);
  assertScopeCanMatchTemplate(scope, loaded.templates);

  for (const [name, template] of Object.entries(loaded.templates)) {
    const repository = repositoryForTemplate(name, template);
    const desired = await resolveDesiredState(
      loaded,
      repository,
      (value) => "validation:" + value,
    );

    buildPlan(emptyCurrentState(repository.name), desired);
  }
}

function assertTemplatesDoNotOverlap(
  scope: RepositorySelector,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): void {
  const entries = Object.entries(templates);

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
    const [leftName, left] = entries[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < entries.length;
      rightIndex++
    ) {
      const [rightName, right] = entries[rightIndex];

      if (selectorsCanOverlap(scope, left.match, right.match)) {
        throw new Error(
          "Repository templates can overlap within configured scope: " +
            leftName + ", " + rightName,
        );
      }
    }
  }
}

function assertScopeCanMatchTemplate(
  scope: RepositorySelector,
  templates: Readonly<Record<string, RepositoryTemplate>>,
): void {
  const templateSelectors = Object.values(templates).map((template) =>
    template.match
  );

  if (
    templateSelectors.length === 0 ||
    !templateSelectors.some((selector) => selectorsCanOverlap(scope, selector))
  ) {
    throw new Error("Configured repository scope cannot match any template");
  }

  for (const name of scope.names ?? []) {
    if (name.includes("*") || name.includes("?")) {
      continue;
    }

    const literalName: RepositorySelector = { names: [name] };
    const possible = templateSelectors.some((selector) =>
      selectorsCanOverlap(scope, literalName, selector)
    );

    if (!possible) {
      throw new Error(
        "Repository " + name +
          " cannot match any template within configured scope",
      );
    }
  }
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
  const initial = patterns.map(() => 0);
  const queue: number[][] = [initial];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const positions = queue.shift()!;
    const key = positions.join(":");

    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    if (
      positions.every((position, index) => position === patterns[index].length)
    ) {
      return true;
    }

    for (let index = 0; index < patterns.length; index++) {
      if (patterns[index][positions[index]] === "*") {
        const advanced = [...positions];
        advanced[index]++;
        queue.push(advanced);
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
      queue.push(tokens.map((token) => token!.next));
    }
  }

  return false;
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

function repositoryForTemplate(
  templateName: string,
  template: RepositoryTemplate,
): RepositoryMetadata {
  const selector = template.match;
  const name = selector.names?.[0]
    ? materializeName(selector.names[0], templateName)
    : "validation-" + templateName;
  const visibility = Array.isArray(selector.visibility)
    ? selector.visibility[0]
    : selector.visibility;

  return {
    name,
    teams: selector.teams ?? [],
    ...(visibility !== undefined && { visibility }),
    properties: selector.properties ?? {},
  };
}

function materializeName(pattern: string, fallback: string): string {
  const value = pattern
    .replaceAll("*", "validation")
    .replaceAll("?", "x");

  return value.length > 0 ? value : "validation-" + fallback;
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
