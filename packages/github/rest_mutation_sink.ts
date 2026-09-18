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
            encodeURIComponent(this.#owner) + "/" + encodeURIComponent(repository),
          { body: { permission: operation.permission.permission.name } },
        );
        return;
      case "remove-team-permission":
        await this.#client.request(
          "DELETE",
          "/orgs/" + encodeURIComponent(this.#owner) + "/teams/" +
            encodeURIComponent(operation.team) + "/repos/" +
            encodeURIComponent(this.#owner) + "/" + encodeURIComponent(repository),
        );
        return;
      case "set-repository-variable":
        await this.setRepositoryVariable(repository, operation.variable);
        return;
      case "remove-repository-variable":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/actions/variables/" +
            encodeURIComponent(operation.name),
        );
        return;
      case "set-repository-secret":
        await this.setSecret(
          this.repo(repository) + "/actions/secrets",
          operation.secret,
        );
        return;
      case "remove-repository-secret":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/actions/secrets/" +
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
      case "update-ruleset":
        await this.#client.request(
          "PUT",
          this.repo(repository) + "/rulesets/" + operation.id,
          { body: mapDesiredRuleset(operation.changes) },
        );
        return;
      case "delete-ruleset":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/rulesets/" + operation.id,
        );
        return;
      case "create-environment":
        await this.applyEnvironment(repository, operation.environment, true);
        return;
      case "update-environment":
        await this.applyEnvironment(repository, operation.environment, false);
        return;
      case "delete-environment":
        await this.#client.request(
          "DELETE",
          this.repo(repository) + "/environments/" +
            encodeURIComponent(operation.name),
        );
        return;
      case "create-file":
        await this.putFile(repository, operation.file.path, operation.file.content);
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
      settings.shaPinningRequired !== undefined
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
            ? current.allowed_actions
            : settings.allowedActions === "local-only"
            ? "local_only"
            : settings.allowedActions,
          sha_pinning_required:
            settings.shaPinningRequired ?? current.sha_pinning_required ?? false,
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
          github_owned_allowed:
            settings.selectedActions.githubOwnedAllowed ??
              current.github_owned_allowed,
          verified_allowed:
            settings.selectedActions.verifiedAllowed ?? current.verified_allowed,
          patterns_allowed:
            settings.selectedActions.patternsAllowed ?? current.patterns_allowed,
        },
      });
    }
  }

  async updateOidc(
    repository: string,
    settings: DesiredActionsOidcSettings,
  ): Promise<void> {
    const path = this.repo(repository) + "/actions/oidc/customization/sub";
    const current = await this.#client.request<{
      readonly use_default: boolean;
      readonly include_claim_keys?: readonly string[];
      readonly use_immutable_subject?: boolean;
    } | undefined>("GET", path, { allowNotFound: true });

    const subject = settings.subjectClaimTemplate;
    const useDefault = subject === undefined
      ? current?.use_default ?? true
      : subject.source !== "custom";
    const claims = subject?.source === "custom"
      ? subject.claims
      : current?.include_claim_keys ?? [];

    await this.#client.request("PUT", path, {
      body: {
        use_default: useDefault,
        include_claim_keys: claims,
        use_immutable_subject:
          settings.immutableSubject ??
            current?.use_immutable_subject ??
            false,
      },
    });
  }

  async setRepositoryVariable(
    repository: string,
    variable: Variable,
  ): Promise<void> {
    const base = this.repo(repository) + "/actions/variables";
    const existing = await this.#client.request<unknown | undefined>(
      "GET",
      base + "/" + encodeURIComponent(variable.name),
      { allowNotFound: true },
    );

    await this.#client.request(existing ? "PATCH" : "POST", existing
      ? base + "/" + encodeURIComponent(variable.name)
      : base, {
      body: {
        name: variable.name,
        value: variable.value,
      },
    });
  }

  async applyEnvironment(
    repository: string,
    environment: DesiredEnvironment,
    create: boolean,
  ): Promise<void> {
    const name = encodeURIComponent(environment.name);
    const base = this.repo(repository) + "/environments/" + name;

    if (create) {
      await this.#client.request("PUT", base, { body: {} });
    }

    if (environment.variables !== undefined) {
      await this.syncEnvironmentVariables(base, environment.variables);
    }

    if (environment.secrets !== undefined) {
      await this.syncEnvironmentSecrets(base, environment.secrets);
    }
  }

  async syncEnvironmentVariables(
    base: string,
    variables: readonly Variable[],
  ): Promise<void> {
    const response = await this.#client.get<{
      readonly variables: readonly { readonly name: string; readonly value: string }[];
    }>(base + "/variables", { per_page: 100 });
    const current = new Set(response.variables.map((variable) => variable.name));
    const desired = new Set(variables.map((variable) => variable.name));

    for (const variable of response.variables) {
      if (!desired.has(variable.name)) {
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
    secrets: readonly string[],
  ): Promise<void> {
    const response = await this.#client.get<{
      readonly secrets: readonly { readonly name: string }[];
    }>(base + "/secrets", { per_page: 100 });
    const desired = new Set(secrets);

    for (const secret of response.secrets) {
      if (!desired.has(secret.name)) {
        await this.#client.request(
          "DELETE",
          base + "/secrets/" + encodeURIComponent(secret.name),
        );
      }
    }

    for (const secret of secrets) {
      await this.setSecret(base + "/secrets", secret);
    }
  }

  async setSecret(base: string, name: string): Promise<void> {
    const publicKey = await this.#client.get<{
      readonly key_id: string;
      readonly key: string;
    }>(base + "/public-key");
    const encrypted = await encryptSecret(
      this.#secretValue(name),
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
          message: "OctoSmith: reconcile " + path,
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

async function encryptSecret(value: string, publicKey: string): Promise<string> {
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
  return mapDesiredRuleset(ruleset);
}

function mapDesiredRuleset(ruleset: DesiredRuleset): Record<string, unknown> {
  return {
    name: ruleset.name,
    ...(ruleset.target !== undefined && { target: ruleset.target }),
    ...(ruleset.enforcement !== undefined && {
      enforcement: ruleset.enforcement,
    }),
    ...(ruleset.bypassActors !== undefined && {
      bypass_actors: ruleset.bypassActors.map((actor) => ({
        ...(actor.actorId !== undefined && { actor_id: actor.actorId }),
        actor_type: pascal(actor.actorType),
        bypass_mode: snake(actor.bypassMode),
      })),
    }),
    ...(ruleset.conditions !== undefined && {
      conditions: snakeObject(ruleset.conditions),
    }),
    ...(ruleset.rules !== undefined && {
      rules: ruleset.rules.map((rule) => {
        const { type, ...parameters } = rule as unknown as Record<string, unknown>;
        return {
          type: snake(String(type)),
          ...(Object.keys(parameters).length > 0 && {
            parameters: snakeObject(parameters),
          }),
        };
      }),
    }),
  };
}

function snakeObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeObject);
  }

  if (value === null || typeof value !== "object") {
    return denormalizeEnum(value);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      snake(key),
      snakeObject(child),
    ]),
  );
}

function denormalizeEnum(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const values = new Set([
    "starts-with",
    "ends-with",
    "all-green",
    "head-green",
    "pull-request",
    "integration-installation",
    "repository-role",
    "errors-and-warnings",
    "high-or-higher",
    "medium-or-higher",
  ]);

  return values.has(value) ? snake(value) : value;
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
