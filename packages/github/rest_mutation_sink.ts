import sodium from "libsodium-wrappers";
import type {
  DesiredActionsOidcSettings,
  DesiredActionsSettings,
  DesiredEnvironment,
  DesiredRepositorySettings,
  DesiredRuleset,
  Operation,
  RulesetDefinition,
  Variable,
} from "@octosmith/core";
import type { GitHubClient } from "./client.ts";
import type { RepositoryMutationSink } from "./apply.ts";

export type SecretValueProvider = (name: string) => string;

export interface GitHubRepositoryMutationSinkOptions {
  readonly client: GitHubClient;
  readonly owner: string;
  readonly secretValue: SecretValueProvider;
}

export class GitHubRepositoryMutationSink implements RepositoryMutationSink {
  readonly #client: GitHubClient;
  readonly #owner: string;
  readonly #secretValue: SecretValueProvider;

  constructor(options: GitHubRepositoryMutationSinkOptions) {
    this.#client = options.client;
    this.#owner = options.owner;
    this.#secretValue = options.secretValue;
  }

  prepare(
    _repository: string,
    operations: readonly Operation[],
  ): RepositoryMutationSink {
    const names = new Set(operations.flatMap((operation) => {
      switch (operation.type) {
        case "set-actions-secret":
        case "set-dependabot-secret":
          return [operation.secret.source];
        case "create-environment":
        case "update-environment":
          return (operation.environment.secrets ?? []).map((secret) =>
            secret.source
          );
        default:
          return [];
      }
    }));
    const values = new Map<string, string>();

    for (const name of names) {
      const value = this.#secretValue(name);
      if (typeof value !== "string") {
        throw new Error("Missing secret value: " + name);
      }
      values.set(name, value);
    }

    return new GitHubRepositoryMutationSink({
      client: this.#client,
      owner: this.#owner,
      secretValue: (name) => {
        const value = values.get(name);
        if (value === undefined) {
          throw new Error("Secret was not prepared: " + name);
        }
        return value;
      },
    });
  }

  async apply(repository: string, operation: Operation): Promise<void> {
    switch (operation.type) {
      case "update-repository-settings":
        await this.updateRepositorySettings(repository, operation.settings);
        return;
      case "set-custom-property":
        await this.#client.request(
          "PATCH",
          this.repo(repository) + "/properties/values",
          {
            body: {
              properties: [{
                property_name: operation.name,
                value: operation.value,
              }],
            },
          },
        );
        return;
      case "update-actions-settings":
        await this.updateActions(repository, operation.settings);
        return;
      case "update-actions-oidc":
        await this.updateOidc(repository, operation.settings);
        return;
      case "set-team-permission":
        await this.#client.request(
          "PUT",
          "/orgs/" + encodeURIComponent(this.#owner) + "/teams/" +
            encodeURIComponent(operation.permission.team) + "/repos/" +
            encodeURIComponent(this.#owner) + "/" +
            encodeURIComponent(repository),
          { body: { permission: operation.permission.permission.name } },
        );
        return;
      case "remove-team-permission":
        await this.#client.request(
          "DELETE",
          "/orgs/" + encodeURIComponent(this.#owner) + "/teams/" +
            encodeURIComponent(operation.team) + "/repos/" +
            encodeURIComponent(this.#owner) + "/" +
            encodeURIComponent(repository),
        );
        return;
      case "set-actions-variable":
        await this.setActionsVariable(repository, operation.variable);
        return;
      case "remove-actions-variable":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/actions/variables/" +
            encodeURIComponent(operation.name),
        );
        return;
      case "set-actions-secret":
        await this.setSecret(
          this.repo(repository) + "/actions/secrets",
          operation.secret.name,
          operation.secret.source,
        );
        return;
      case "remove-actions-secret":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/actions/secrets/" +
            encodeURIComponent(operation.secret),
        );
        return;
      case "set-dependabot-secret":
        await this.setSecret(
          this.repo(repository) + "/dependabot/secrets",
          operation.secret.name,
          operation.secret.source,
        );
        return;
      case "remove-dependabot-secret":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/dependabot/secrets/" +
            encodeURIComponent(operation.secret),
        );
        return;
      case "create-ruleset":
        await this.#client.request(
          "POST",
          this.repo(repository) + "/rulesets",
          { body: mapRuleset(operation.ruleset) },
        );
        return;
      case "update-ruleset": {
        const path = this.repo(repository) + "/rulesets/" + operation.id;
        const current = await this.#client.get<Record<string, unknown>>(path, {
          includes_parents: false,
        });
        await this.#client.request(
          "PUT",
          path,
          { body: materializeRulesetUpdate(current, operation.changes) },
        );
        return;
      }
      case "delete-ruleset":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/rulesets/" + operation.id,
        );
        return;
      case "create-environment":
        await this.applyEnvironment(
          repository,
          operation.environment,
          true,
          "explicit",
        );
        return;
      case "update-environment":
        await this.applyEnvironment(
          repository,
          operation.environment,
          false,
          operation.collections,
        );
        return;
      case "delete-environment":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/environments/" +
            encodeURIComponent(operation.name),
        );
        return;
      case "create-file":
        await this.putFile(
          repository,
          operation.file.path,
          operation.file.content,
        );
        return;
      case "update-file":
        await this.putFile(
          repository,
          operation.file.path,
          operation.file.content,
          operation.sha,
        );
        return;
      case "delete-file":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/contents/" + encodePath(operation.path),
          {
            body: {
              message: "OctoSmith: remove " + operation.path,
              sha: operation.sha,
            },
          },
        );
        return;
    }
  }

  async updateRepositorySettings(
    repository: string,
    settings: DesiredRepositorySettings,
  ): Promise<void> {
    const { topics, ...rest } = settings;

    if (Object.keys(rest).length > 0) {
      await this.#client.request("PATCH", this.repo(repository), {
        body: mapRepositorySettings(rest),
      });
    }

    if (topics !== undefined) {
      await this.#client.request(
        "PUT",
        this.repo(repository) + "/topics",
        { body: { names: topics } },
      );
    }
  }

  async updateActions(
    repository: string,
    settings: DesiredActionsSettings,
  ): Promise<void> {
    const base = this.repo(repository) + "/actions/permissions";

    if (
      settings.enabled !== undefined ||
      settings.allowedActions !== undefined ||
      settings.shaPinningRequired !== undefined ||
      settings.selectedActions !== undefined
    ) {
      const current = await this.#client.get<{
        readonly enabled: boolean;
        readonly allowed_actions: "all" | "local_only" | "selected";
        readonly sha_pinning_required?: boolean;
      }>(base);

      await this.#client.request("PUT", base, {
        body: {
          enabled: settings.enabled ?? current.enabled,
          allowed_actions: settings.allowedActions === undefined
            ? settings.selectedActions !== undefined
              ? "selected"
              : current.allowed_actions
            : settings.allowedActions === "local-only"
            ? "local_only"
            : settings.allowedActions,
          sha_pinning_required: settings.shaPinningRequired ??
            current.sha_pinning_required ??
            false,
        },
      });
    }

    if (settings.selectedActions !== undefined) {
      const path = base + "/selected-actions";
      const current = await this.#client.get<{
        readonly github_owned_allowed: boolean;
        readonly verified_allowed: boolean;
        readonly patterns_allowed: readonly string[];
      }>(path);

      await this.#client.request("PUT", path, {
        body: {
          github_owned_allowed: settings.selectedActions.githubOwnedAllowed ??
            current.github_owned_allowed,
          verified_allowed: settings.selectedActions.verifiedAllowed ??
            current.verified_allowed,
          patterns_allowed: settings.selectedActions.patternsAllowed ??
            current.patterns_allowed,
        },
      });
    }
  }

  async updateOidc(
    repository: string,
    settings: DesiredActionsOidcSettings,
  ): Promise<void> {
    const path = this.repo(repository) + "/actions/oidc/customization/sub";
    const current = await this.#client.request<
      {
        readonly use_default: boolean;
        readonly include_claim_keys?: readonly string[];
        readonly use_immutable_subject?: boolean;
      } | undefined
    >("GET", path, { allowNotFound: true });

    const subject = settings.subjectClaimTemplate;
    const useDefault = subject === undefined
      ? current?.use_default ?? true
      : subject.source === "default";
    const claims = subject === undefined
      ? current?.include_claim_keys
      : subject.source === "custom"
      ? subject.claims
      : undefined;

    await this.#client.request("PUT", path, {
      body: {
        use_default: useDefault,
        ...(claims !== undefined && { include_claim_keys: claims }),
        use_immutable_subject: settings.immutableSubject ??
          current?.use_immutable_subject ??
          false,
      },
    });
  }

  async setActionsVariable(
    repository: string,
    variable: Variable,
  ): Promise<void> {
    const base = this.repo(repository) + "/actions/variables";
    const existing = await this.#client.request<unknown | undefined>(
      "GET",
      base + "/" + encodeURIComponent(variable.name),
      { allowNotFound: true },
    );

    await this.#client.request(
      existing ? "PATCH" : "POST",
      existing ? base + "/" + encodeURIComponent(variable.name) : base,
      {
        body: {
          name: variable.name,
          value: variable.value,
        },
      },
    );
  }

  async applyEnvironment(
    repository: string,
    environment: DesiredEnvironment,
    create: boolean,
    collections: "explicit" | "strict",
  ): Promise<void> {
    const name = encodeURIComponent(environment.name);
    const base = this.repo(repository) + "/environments/" + name;

    if (create) {
      await this.#client.request("PUT", base, { body: {} });
    }

    if (environment.variables !== undefined) {
      await this.syncEnvironmentVariables(
        base,
        environment.variables,
        collections,
      );
    }

    if (environment.secrets !== undefined) {
      await this.syncEnvironmentSecrets(
        base,
        environment.secrets,
        collections,
      );
    }
  }

  async syncEnvironmentVariables(
    base: string,
    variables: readonly Variable[],
    collections: "explicit" | "strict",
  ): Promise<void> {
    const currentVariables = await getAllWrappedPages<{
      readonly name: string;
      readonly value: string;
    }>(
      this.#client,
      base + "/variables",
      "variables",
    );
    const current = new Set(
      currentVariables.map((variable) => variable.name),
    );
    const desired = new Set(variables.map((variable) => variable.name));

    const removeUndeclared = collections === "strict" || variables.length === 0;

    for (const variable of currentVariables) {
      if (removeUndeclared && !desired.has(variable.name)) {
        await this.#client.request(
          "DELETE",
          base + "/variables/" + encodeURIComponent(variable.name),
        );
      }
    }

    for (const variable of variables) {
      const exists = current.has(variable.name);
      await this.#client.request(
        exists ? "PATCH" : "POST",
        exists
          ? base + "/variables/" + encodeURIComponent(variable.name)
          : base + "/variables",
        { body: { name: variable.name, value: variable.value } },
      );
    }
  }

  async syncEnvironmentSecrets(
    base: string,
    secrets: readonly import("@octosmith/core").DesiredSecret[],
    collections: "explicit" | "strict",
  ): Promise<void> {
    const currentSecrets = await getAllWrappedPages<{
      readonly name: string;
    }>(
      this.#client,
      base + "/secrets",
      "secrets",
    );
    const desired = new Set(secrets.map((secret) => secret.name));

    const removeUndeclared = collections === "strict" || secrets.length === 0;

    for (const secret of currentSecrets) {
      if (removeUndeclared && !desired.has(secret.name)) {
        await this.#client.request(
          "DELETE",
          base + "/secrets/" + encodeURIComponent(secret.name),
        );
      }
    }

    for (const secret of secrets) {
      await this.setSecret(base + "/secrets", secret.name, secret.source);
    }
  }

  async setSecret(base: string, name: string, source: string): Promise<void> {
    const publicKey = await this.#client.get<{
      readonly key_id: string;
      readonly key: string;
    }>(base + "/public-key");
    const encrypted = await encryptSecret(
      this.#secretValue(source),
      publicKey.key,
    );

    await this.#client.request(
      "PUT",
      base + "/" + encodeURIComponent(name),
      {
        body: {
          encrypted_value: encrypted,
          key_id: publicKey.key_id,
        },
      },
    );
  }

  async putFile(
    repository: string,
    path: string,
    content: string,
    sha?: string,
  ): Promise<void> {
    await this.#client.request(
      "PUT",
      this.repo(repository) + "/contents/" + encodePath(path),
      {
        body: {
          message: "OctoSmith: apply " + path,
          content: encodeBase64(content),
          ...(sha !== undefined && { sha }),
        },
      },
    );
  }

  private repo(repository: string): string {
    return "/repos/" + encodeURIComponent(this.#owner) + "/" +
      encodeURIComponent(repository);
  }
}

const PAGE_SIZE = 100;

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

async function encryptSecret(
  value: string,
  publicKey: string,
): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(
    publicKey,
    sodium.base64_variants.ORIGINAL,
  );
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(value),
    key,
  );

  return sodium.to_base64(
    encrypted,
    sodium.base64_variants.ORIGINAL,
  );
}

function mapRepositorySettings(
  settings: Omit<DesiredRepositorySettings, "topics">,
): Record<string, unknown> {
  const merge = settings.merge;
  const security = settings.securityAndAnalysis;

  return {
    ...(settings.description !== undefined && {
      description: settings.description,
    }),
    ...(settings.website !== undefined && { homepage: settings.website }),
    ...(settings.visibility !== undefined && {
      visibility: settings.visibility,
    }),
    ...(settings.hasIssues !== undefined && { has_issues: settings.hasIssues }),
    ...(settings.hasProjects !== undefined && {
      has_projects: settings.hasProjects,
    }),
    ...(settings.hasWiki !== undefined && { has_wiki: settings.hasWiki }),
    ...(settings.hasDiscussions !== undefined && {
      has_discussions: settings.hasDiscussions,
    }),
    ...(settings.hasPullRequests !== undefined && {
      has_pull_requests: settings.hasPullRequests,
    }),
    ...(settings.pullRequestCreationPolicy !== undefined && {
      pull_request_creation_policy:
        settings.pullRequestCreationPolicy === "collaborators-only"
          ? "collaborators_only"
          : "all",
    }),
    ...(settings.isTemplate !== undefined && {
      is_template: settings.isTemplate,
    }),
    ...(settings.defaultBranch !== undefined && {
      default_branch: settings.defaultBranch,
    }),
    ...(settings.archived !== undefined && { archived: settings.archived }),
    ...(settings.allowForking !== undefined && {
      allow_forking: settings.allowForking,
    }),
    ...(settings.webCommitSignoffRequired !== undefined && {
      web_commit_signoff_required: settings.webCommitSignoffRequired,
    }),
    ...(merge?.allowSquashMerge !== undefined && {
      allow_squash_merge: merge.allowSquashMerge,
    }),
    ...(merge?.allowMergeCommit !== undefined && {
      allow_merge_commit: merge.allowMergeCommit,
    }),
    ...(merge?.allowRebaseMerge !== undefined && {
      allow_rebase_merge: merge.allowRebaseMerge,
    }),
    ...(merge?.allowAutoMerge !== undefined && {
      allow_auto_merge: merge.allowAutoMerge,
    }),
    ...(merge?.allowUpdateBranch !== undefined && {
      allow_update_branch: merge.allowUpdateBranch,
    }),
    ...(merge?.deleteBranchOnMerge !== undefined && {
      delete_branch_on_merge: merge.deleteBranchOnMerge,
    }),
    ...(merge?.squashMergeCommitTitle !== undefined && {
      squash_merge_commit_title:
        merge.squashMergeCommitTitle === "commit-or-pull-request-title"
          ? "COMMIT_OR_PR_TITLE"
          : "PR_TITLE",
    }),
    ...(merge?.squashMergeCommitMessage !== undefined && {
      squash_merge_commit_message: merge.squashMergeCommitMessage === "blank"
        ? "BLANK"
        : merge.squashMergeCommitMessage === "commit-messages"
        ? "COMMIT_MESSAGES"
        : "PR_BODY",
    }),
    ...(merge?.mergeCommitTitle !== undefined && {
      merge_commit_title: merge.mergeCommitTitle === "merge-message"
        ? "MERGE_MESSAGE"
        : "PR_TITLE",
    }),
    ...(merge?.mergeCommitMessage !== undefined && {
      merge_commit_message: merge.mergeCommitMessage === "blank"
        ? "BLANK"
        : merge.mergeCommitMessage === "pull-request-title"
        ? "PR_TITLE"
        : "PR_BODY",
    }),
    ...(security !== undefined && {
      security_and_analysis: Object.fromEntries(
        Object.entries(security).map(([key, status]) => [
          snake(key),
          { status },
        ]),
      ),
    }),
  };
}

function mapRuleset(ruleset: RulesetDefinition): Record<string, unknown> {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: mapBypassActors(ruleset.bypassActors),
    ...(ruleset.target !== "push" && {
      conditions: snakeKeys(ruleset.conditions),
    }),
    rules: ruleset.rules.map(mapRule),
  };
}

function materializeRulesetUpdate(
  current: Record<string, unknown>,
  changes: DesiredRuleset,
): Record<string, unknown> {
  const target = changes.target ?? String(current.target);

  return {
    name: changes.name || String(current.name),
    target,
    enforcement: changes.enforcement ?? current.enforcement,
    bypass_actors: changes.bypassActors !== undefined
      ? mapBypassActors(changes.bypassActors)
      : current.bypass_actors ?? [],
    ...(target !== "push" && {
      conditions: changes.conditions !== undefined
        ? snakeKeys(changes.conditions)
        : current.conditions ?? {
          ref_name: {
            include: [],
            exclude: [],
          },
        },
    }),
    rules: changes.rules !== undefined
      ? changes.rules.map(mapRule)
      : current.rules ?? [],
  };
}

function mapBypassActors(
  actors: readonly import("@octosmith/core").RulesetBypassActor[],
): readonly Record<string, unknown>[] {
  return actors.map((actor) => ({
    ...(actor.actorId !== undefined && { actor_id: actor.actorId }),
    actor_type: pascal(actor.actorType),
    bypass_mode: snake(actor.bypassMode),
  }));
}

function mapRule(
  rule: import("@octosmith/core").DesiredRulesetRule,
): Record<string, unknown> {
  const { type, ...parameters } = rule as unknown as Record<string, unknown>;
  const mapped = snakeKeys(parameters) as Record<string, unknown>;

  switch (type) {
    case "commit-message-pattern":
    case "commit-author-email-pattern":
    case "committer-email-pattern":
    case "branch-name-pattern":
    case "tag-name-pattern":
      if (typeof mapped.operator === "string") {
        mapped.operator = snake(mapped.operator);
      }
      break;

    case "merge-queue":
      if (typeof mapped.grouping_strategy === "string") {
        mapped.grouping_strategy = mapped.grouping_strategy === "all-green"
          ? "ALLGREEN"
          : mapped.grouping_strategy === "head-green"
          ? "HEADGREEN"
          : mapped.grouping_strategy;
      }
      if (typeof mapped.merge_method === "string") {
        mapped.merge_method = mapped.merge_method.toUpperCase();
      }
      break;

    case "required-deployments":
      mapped.required_deployment_environments = Reflect.get(
        rule,
        "environments",
      ) ?? [];
      delete mapped.environments;
      break;

    case "required-status-checks": {
      const checks = Reflect.get(rule, "checks") as
        | readonly {
          readonly context: string;
          readonly integrationId?: number;
        }[]
        | undefined;

      mapped.required_status_checks = (checks ?? []).map((check) => ({
        context: check.context,
        ...(check.integrationId !== undefined && {
          integration_id: check.integrationId,
        }),
      }));
      mapped.strict_required_status_checks_policy = Reflect.get(
        rule,
        "strict",
      );
      delete mapped.checks;
      delete mapped.strict;
      break;
    }

    case "pull-request": {
      const restriction = Reflect.get(rule, "dismissalRestriction") as
        | {
          readonly enabled?: boolean;
          readonly allowedActors?: readonly {
            readonly id: number;
            readonly type: string;
          }[];
        }
        | undefined;

      if (restriction !== undefined) {
        mapped.dismissal_restriction = {
          ...(restriction.enabled !== undefined && {
            enabled: restriction.enabled,
          }),
          ...(restriction.allowedActors !== undefined && {
            allowed_actors: restriction.allowedActors.map((actor) => ({
              id: actor.id,
              type: pascal(actor.type),
            })),
          }),
        };
      }

      const requiredReviewers = Reflect.get(rule, "requiredReviewers") as
        | readonly {
          readonly reviewerTeamId: number;
          readonly filePatterns: readonly string[];
          readonly minimumApprovals: number;
        }[]
        | undefined;

      if (requiredReviewers !== undefined) {
        mapped.required_reviewers = requiredReviewers.map((reviewer) => ({
          file_patterns: reviewer.filePatterns,
          minimum_approvals: reviewer.minimumApprovals,
          reviewer: {
            id: reviewer.reviewerTeamId,
            type: "Team",
          },
        }));
      }
      break;
    }

    case "code-scanning": {
      const tools = Reflect.get(rule, "tools") as
        | readonly {
          readonly tool: string;
          readonly alertsThreshold: string;
          readonly securityAlertsThreshold: string;
        }[]
        | undefined;

      if (tools !== undefined) {
        mapped.code_scanning_tools = tools.map((tool) => ({
          tool: tool.tool,
          alerts_threshold: snake(tool.alertsThreshold),
          security_alerts_threshold: snake(tool.securityAlertsThreshold),
        }));
      }
      delete mapped.tools;
      break;
    }

    case "max-file-size":
      mapped.max_file_size = Reflect.get(rule, "maxFileSizeMb");
      delete mapped.max_file_size_mb;
      break;
  }

  return {
    type: snake(String(type)),
    ...(Object.keys(mapped).length > 0 && { parameters: mapped }),
  };
}

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeKeys);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      snake(key),
      snakeKeys(child),
    ]),
  );
}

function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

function pascal(value: string): string {
  return value
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
