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

  assertTemplatesDoNotOverlap(loaded.templates);
  assertLiteralScopeCanMatchTemplate(
    loaded.configuration.repositories.scope.names ?? [],
    loaded.templates,
  );

  for (const [name, template] of Object.entries(loaded.templates)) {
    const repository = repositoryForTemplate(name, template);
    const isolated: LoadedConfiguration = {
      ...loaded,
      templates: { [name]: template },
    };
    const desired = await resolveDesiredState(
      isolated,
      repository,
      (value) => "validation:" + value,
    );

    buildPlan(emptyCurrentState(repository.name), desired);
  }
}

function assertTemplatesDoNotOverlap(
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

      if (selectorsCanOverlap(left.match, right.match)) {
        throw new Error(
          "Repository templates can overlap: " + leftName + ", " + rightName,
        );
      }
    }
  }
}

function assertLiteralScopeCanMatchTemplate(
  names: readonly string[],
  templates: Readonly<Record<string, RepositoryTemplate>>,
): void {
  for (const name of names) {
    if (name.includes("*") || name.includes("?")) {
      continue;
    }

    const possible = Object.values(templates).some((template) =>
      selectorCanPossiblyMatchName(template.match, name)
    );

    if (!possible) {
      throw new Error(
        "Repository " + name + " cannot match any configured template",
      );
    }
  }
}

function selectorCanPossiblyMatchName(
  selector: RepositorySelector,
  name: string,
): boolean {
  if (selector.names === undefined) {
    return true;
  }

  return selector.names.some((pattern) =>
    matchesSelector(
      { names: [pattern] },
      { name, teams: [], properties: {} },
    )
  );
}

function selectorsCanOverlap(
  left: RepositorySelector,
  right: RepositorySelector,
): boolean {
  if (!nameSelectorsCanOverlap(left.names, right.names)) {
    return false;
  }

  if (!visibilityCanOverlap(left.visibility, right.visibility)) {
    return false;
  }

  if (!propertiesCanOverlap(left.properties, right.properties)) {
    return false;
  }

  // Team selectors are conjunctions. A repository can satisfy both by belonging
  // to the union of both team sets.
  return true;
}

function nameSelectorsCanOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return true;
  }

  return left.some((leftPattern) =>
    right.some((rightPattern) =>
      globPatternsCanOverlap(leftPattern, rightPattern)
    )
  );
}

function visibilityCanOverlap(
  left: RepositorySelector["visibility"],
  right: RepositorySelector["visibility"],
): boolean {
  if (left === undefined || right === undefined) {
    return true;
  }

  const leftValues = Array.isArray(left) ? left : [left];
  const rightValues = Array.isArray(right) ? right : [right];

  return leftValues.some((value) => rightValues.includes(value));
}

function propertiesCanOverlap(
  left: Readonly<Record<string, PropertyValue>> | undefined,
  right: Readonly<Record<string, PropertyValue>> | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return true;
  }

  for (const [name, leftValue] of Object.entries(left)) {
    if (name in right && !equalPropertyValue(leftValue, right[name])) {
      return false;
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

function globPatternsCanOverlap(left: string, right: string): boolean {
  const queue: Array<readonly [number, number]> = [[0, 0]];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.shift()!;
    const key = leftIndex + ":" + rightIndex;

    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    if (leftIndex === left.length && rightIndex === right.length) {
      return true;
    }

    if (left[leftIndex] === "*") {
      queue.push([leftIndex + 1, rightIndex]);
    }
    if (right[rightIndex] === "*") {
      queue.push([leftIndex, rightIndex + 1]);
    }

    const leftToken = consumingToken(left, leftIndex);
    const rightToken = consumingToken(right, rightIndex);

    if (
      leftToken !== undefined &&
      rightToken !== undefined &&
      tokensCanMatchSameCharacter(leftToken.token, rightToken.token)
    ) {
      queue.push([leftToken.next, rightToken.next]);
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
  left: string | null,
  right: string | null,
): boolean {
  return left === null || right === null || left === right;
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
