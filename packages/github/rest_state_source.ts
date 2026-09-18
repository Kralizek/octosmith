import type {
  ActionsAllowedActions,
  BuiltInRepositoryPermission,
  CurrentActionsSettings,
  CurrentFile,
  CurrentRepositorySettings,
  CurrentRuleset,
  CustomPropertyValue,
  Environment,
  RepositoryPermission,
  RepositoryVisibility,
  SecretName,
  TeamPermission,
  Variable,
} from "@octosmith/core";
import type { GitHubClient } from "./client.ts";
import type { RepositoryStateSource } from "./state_source.ts";

interface RepositoryResponse {
  readonly name: string;
  readonly description: string | null;
  readonly homepage: string | null;
  readonly topics?: readonly string[];
  readonly visibility: RepositoryVisibility;
  readonly has_issues: boolean;
  readonly has_projects: boolean;
  readonly has_wiki: boolean;
  readonly has_discussions: boolean;
  readonly has_pull_requests: boolean;
  readonly pull_request_creation_policy?: "all" | "collaborators_only";
  readonly is_template: boolean;
  readonly default_branch: string;
  readonly allow_squash_merge: boolean;
  readonly allow_merge_commit: boolean;
  readonly allow_rebase_merge: boolean;
  readonly allow_auto_merge: boolean;
  readonly allow_update_branch?: boolean;
  readonly delete_branch_on_merge: boolean;
  readonly squash_merge_commit_title: string;
  readonly squash_merge_commit_message: string;
  readonly merge_commit_title: string;
  readonly merge_commit_message: string;
  readonly archived: boolean;
  readonly allow_forking?: boolean;
  readonly web_commit_signoff_required?: boolean;
  readonly security_and_analysis?: Record<
    string,
    { readonly status: "enabled" | "disabled" }
  >;
}

export class GitHubRepositoryStateSource implements RepositoryStateSource {
  constructor(
    readonly client: GitHubClient,
    readonly owner: string,
  ) {}

  async getRepositorySettings(
    repository: string,
  ): Promise<CurrentRepositorySettings> {
    const response = await this.client.get<RepositoryResponse>(
      this.repo(repository),
    );

    return {
      name: response.name,
      description: response.description,
      website: response.homepage,
      topics: response.topics ?? [],
      visibility: response.visibility,
      hasIssues: response.has_issues,
      hasProjects: response.has_projects,
      hasWiki: response.has_wiki,
      hasDiscussions: response.has_discussions,
      hasPullRequests: response.has_pull_requests,
      pullRequestCreationPolicy:
        response.pull_request_creation_policy === "collaborators_only"
          ? "collaborators-only"
          : "all",
      isTemplate: response.is_template,
      defaultBranch: response.default_branch,
      merge: {
        allowSquashMerge: response.allow_squash_merge,
        allowMergeCommit: response.allow_merge_commit,
        allowRebaseMerge: response.allow_rebase_merge,
        allowAutoMerge: response.allow_auto_merge,
        allowUpdateBranch: response.allow_update_branch ?? false,
        deleteBranchOnMerge: response.delete_branch_on_merge,
        squashMergeCommitTitle: mapSquashTitle(
          response.squash_merge_commit_title,
        ),
        squashMergeCommitMessage: mapSquashMessage(
          response.squash_merge_commit_message,
        ),
        mergeCommitTitle: mapMergeTitle(response.merge_commit_title),
        mergeCommitMessage: mapMergeMessage(response.merge_commit_message),
      },
      archived: response.archived,
      allowForking: response.allow_forking ?? false,
      webCommitSignoffRequired: response.web_commit_signoff_required ?? false,
      securityAndAnalysis: mapSecurity(response.security_and_analysis),
    };
  }

  async getCustomProperties(
    repository: string,
  ): Promise<Readonly<Record<string, CustomPropertyValue>>> {
    const values = await getAllPages<
      {
        readonly property_name: string;
        readonly value: CustomPropertyValue;
      }
    >(this.client, this.repo(repository) + "/properties/values");

    return Object.fromEntries(
      values.map((value) => [value.property_name, value.value]),
    );
  }

  async getActionsSettings(
    repository: string,
  ): Promise<CurrentActionsSettings> {
    const base = this.repo(repository) + "/actions";
    const permissions = await this.client.get<{
      readonly enabled: boolean;
      readonly allowed_actions: "all" | "local_only" | "selected";
      readonly sha_pinning_required?: boolean;
    }>(base + "/permissions");

    const selected = permissions.allowed_actions === "selected"
      ? await this.client.get<{
        readonly github_owned_allowed: boolean;
        readonly verified_allowed: boolean;
        readonly patterns_allowed: readonly string[];
      }>(base + "/permissions/selected-actions")
      : undefined;

    const oidc = await this.client.request<
      {
        readonly use_default: boolean;
        readonly include_claim_keys?: readonly string[];
        readonly use_immutable_subject?: boolean;
      } | undefined
    >("GET", base + "/oidc/customization/sub", {
      allowNotFound: true,
    });

    return {
      enabled: permissions.enabled,
      allowedActions: mapAllowedActions(permissions.allowed_actions),
      shaPinningRequired: permissions.sha_pinning_required ?? false,
      ...(selected && {
        selectedActions: {
          githubOwnedAllowed: selected.github_owned_allowed,
          verifiedAllowed: selected.verified_allowed,
          patternsAllowed: selected.patterns_allowed,
        },
      }),
      oidc: oidc
        ? {
          subjectClaimTemplate: oidc.use_default ? { source: "default" } : {
            source: "custom",
            claims: oidc.include_claim_keys ?? [],
          },
          immutableSubject: oidc.use_immutable_subject ?? false,
        }
        : {
          subjectClaimTemplate: { source: "default" },
          immutableSubject: false,
        },
    };
  }

  async getTeams(repository: string): Promise<readonly TeamPermission[]> {
    const teams = await getAllPages<
      {
        readonly slug: string;
        readonly permission: string;
      }
    >(this.client, this.repo(repository) + "/teams");

    return teams.map((team) => ({
      team: team.slug,
      permission: mapPermission(team.permission),
    }));
  }

  async getSecrets(repository: string): Promise<readonly SecretName[]> {
    const secrets = await getAllWrappedPages<
      { readonly name: string }
    >(
      this.client,
      this.repo(repository) + "/actions/secrets",
      "secrets",
    );

    return secrets.map((secret) => secret.name);
  }

  async getVariables(repository: string): Promise<readonly Variable[]> {
    const variables = await getAllWrappedPages<
      {
        readonly name: string;
        readonly value: string;
      }
    >(
      this.client,
      this.repo(repository) + "/actions/variables",
      "variables",
    );

    return variables.map((variable) => ({
      name: variable.name,
      value: variable.value,
    }));
  }

  async getRulesets(repository: string): Promise<readonly CurrentRuleset[]> {
    const summaries = await getAllPages<
      {
        readonly id: number;
        readonly source_type?: string;
      }
    >(
      this.client,
      this.repo(repository) + "/rulesets",
      { includes_parents: false },
    );

    const repositoryRules = summaries.filter((summary) =>
      summary.source_type === undefined || summary.source_type === "Repository"
    );

    return await Promise.all(
      repositoryRules.map(async (summary) =>
        mapRuleset(
          await this.client.get<Record<string, unknown>>(
            this.repo(repository) + "/rulesets/" + summary.id,
            { includes_parents: false },
          ),
        )
      ),
    );
  }

  async getEnvironments(repository: string): Promise<readonly Environment[]> {
    const environments = await getAllWrappedPages<
      { readonly name: string }
    >(
      this.client,
      this.repo(repository) + "/environments",
      "environments",
    );

    return await Promise.all(
      environments.map(async (environment) => {
        const name = encodeURIComponent(environment.name);
        const base = this.repo(repository) + "/environments/" + name;
        const [secrets, variables] = await Promise.all([
          getAllWrappedPages<{ readonly name: string }>(
            this.client,
            base + "/secrets",
            "secrets",
          ),
          getAllWrappedPages<{
            readonly name: string;
            readonly value: string;
          }>(
            this.client,
            base + "/variables",
            "variables",
          ),
        ]);

        return {
          name: environment.name,
          secrets: secrets.map((secret) => secret.name),
          variables: variables.map((variable) => ({
            name: variable.name,
            value: variable.value,
          })),
        };
      }),
    );
  }

  async getFile(
    repository: string,
    path: string,
  ): Promise<CurrentFile | undefined> {
    const result = await this.client.request<
      {
        readonly type: "file";
        readonly content: string;
        readonly encoding: "base64";
        readonly sha: string;
      } | undefined
    >(
      "GET",
      this.repo(repository) + "/contents/" + encodePath(path),
      { allowNotFound: true },
    );

    if (!result) {
      return undefined;
    }

    if (result.type !== "file" || result.encoding !== "base64") {
      throw new Error("Managed path is not a base64 file: " + path);
    }

    return {
      path,
      content: decodeBase64(result.content),
      sha: result.sha,
    };
  }

  private repo(repository: string): string {
    return "/repos/" + encodeURIComponent(this.owner) + "/" +
      encodeURIComponent(repository);
  }
}

const PAGE_SIZE = 100;

async function getAllPages<T>(
  client: GitHubClient,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> = {},
): Promise<readonly T[]> {
  const result: T[] = [];

  for (let page = 1;; page++) {
    const items = await client.get<readonly T[]>(path, {
      ...query,
      per_page: PAGE_SIZE,
      page,
    });
    result.push(...items);

    if (items.length < PAGE_SIZE) {
      return result;
    }
  }
}

async function getAllWrappedPages<T>(
  client: GitHubClient,
  path: string,
  field: string,
): Promise<readonly T[]> {
  const result: T[] = [];

  for (let page = 1;; page++) {
    const response = await client.get<Record<string, unknown>>(path, {
      per_page: PAGE_SIZE,
      page,
    });
    const items = Reflect.get(response, field) as readonly T[];
    result.push(...items);

    if (items.length < PAGE_SIZE) {
      return result;
    }
  }
}

function mapAllowedActions(
  value: "all" | "local_only" | "selected",
): ActionsAllowedActions {
  return value === "local_only" ? "local-only" : value;
}

function mapPermission(value: string): RepositoryPermission {
  const builtIns = new Set<BuiltInRepositoryPermission>([
    "pull",
    "triage",
    "push",
    "maintain",
    "admin",
  ]);

  return builtIns.has(value as BuiltInRepositoryPermission)
    ? { kind: "built-in", name: value as BuiltInRepositoryPermission }
    : { kind: "custom", name: value };
}

function mapSecurity(
  value: RepositoryResponse["security_and_analysis"],
): CurrentRepositorySettings["securityAndAnalysis"] {
  if (!value) {
    return {};
  }

  return {
    ...(value.advanced_security && {
      advancedSecurity: value.advanced_security.status,
    }),
    ...(value.code_security && {
      codeSecurity: value.code_security.status,
    }),
    ...(value.secret_scanning && {
      secretScanning: value.secret_scanning.status,
    }),
    ...(value.secret_scanning_push_protection && {
      secretScanningPushProtection:
        value.secret_scanning_push_protection.status,
    }),
    ...(value.secret_scanning_ai_detection && {
      secretScanningAiDetection: value.secret_scanning_ai_detection.status,
    }),
  };
}

function mapRuleset(value: Record<string, unknown>): CurrentRuleset {
  const target = value.target as "branch" | "tag" | "push";
  const rules = (value.rules as readonly Record<string, unknown>[] ?? []).map(
    mapRule,
  );
  const bypassActors = (
    value.bypass_actors as readonly Record<string, unknown>[] ?? []
  ).map((actor) => ({
    actorType: kebab(
      String(actor.actor_type),
    ) as import("@octosmith/core").RulesetBypassActor["actorType"],
    ...(actor.actor_id !== null && actor.actor_id !== undefined && {
      actorId: Number(actor.actor_id),
    }),
    bypassMode: kebab(
      String(actor.bypass_mode),
    ) as import("@octosmith/core").RulesetBypassActor["bypassMode"],
  }));

  const common = {
    id: Number(value.id),
    name: String(value.name),
    target,
    enforcement: value.enforcement as "disabled" | "evaluate" | "active",
    bypassActors,
    rules,
  };

  if (target === "push") {
    return common as CurrentRuleset;
  }

  const conditions = value.conditions as {
    readonly ref_name?: {
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
    };
  } | undefined;

  return {
    ...common,
    conditions: {
      refName: {
        include: conditions?.ref_name?.include ?? [],
        exclude: conditions?.ref_name?.exclude ?? [],
      },
    },
  } as CurrentRuleset;
}

function mapRule(value: Record<string, unknown>):
  | import("@octosmith/core").CurrentRefRule
  | import("@octosmith/core").CurrentPushRule {
  const type = kebab(String(value.type));
  const parameters = camelizeObject(
    (value.parameters as Record<string, unknown> | undefined) ?? {},
  ) as Record<string, unknown>;

  return {
    type,
    ...parameters,
  } as
    | import("@octosmith/core").CurrentRefRule
    | import("@octosmith/core").CurrentPushRule;
}

function camelizeObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelizeObject);
  }

  if (value === null || typeof value !== "object") {
    return normalizeEnum(value);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      camelizeObject(child),
    ]),
  );
}

function normalizeEnum(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const enumValues = new Set([
    "starts_with",
    "ends_with",
    "all_green",
    "head_green",
    "pull_request",
    "integration_installation",
    "repository_role",
    "errors_and_warnings",
    "high_or_higher",
    "medium_or_higher",
  ]);

  return enumValues.has(value) ? kebab(value) : value;
}

function kebab(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
}

function mapSquashTitle(value: string) {
  return value === "COMMIT_OR_PR_TITLE"
    ? "commit-or-pull-request-title" as const
    : "pull-request-title" as const;
}

function mapSquashMessage(value: string) {
  if (value === "COMMIT_MESSAGES") return "commit-messages" as const;
  if (value === "BLANK") return "blank" as const;
  return "pull-request-body" as const;
}

function mapMergeTitle(value: string) {
  return value === "MERGE_MESSAGE"
    ? "merge-message" as const
    : "pull-request-title" as const;
}

function mapMergeMessage(value: string) {
  if (value === "PR_TITLE") return "pull-request-title" as const;
  if (value === "BLANK") return "blank" as const;
  return "pull-request-body" as const;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(
    atob(value.replaceAll("\n", "")),
    (character) => character.charCodeAt(0),
  );

  return new TextDecoder().decode(bytes);
}
