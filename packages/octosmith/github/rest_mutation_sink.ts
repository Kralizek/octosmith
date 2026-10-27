import sodium from "libsodium-wrappers";
import { persistedOperationSecretSources } from "../plan/operation_contract.ts";
import type {
  DesiredActionsOidcSettings,
  DesiredActionsSettings,
  DesiredEnvironment,
  DesiredRepositorySettings,
  DesiredRuleset,
  FileChangesConfiguration,
  ManagedFileSnapshot,
  Operation,
  ReconciliationScope,
  RulesetDefinition,
  Variable,
} from "../mod.ts";
import { type GitHubClient, GitHubRequestError } from "./client.ts";
import type { RepositoryMutationSink } from "./apply.ts";
import type { PullRequestResult } from "../report/types.ts";
import { reconcileFilePullRequest } from "./file_pull_request.ts";
import type { RepositoryBootstrap } from "./bootstrap.ts";
import { GitHubRepositoryStateSource } from "./rest_state_source.ts";
import { createManagedFileTree } from "./file_tree.ts";
import {
  assertBootstrapFileOwned,
  assertNoBootstrapFileDeclarations,
  BOOTSTRAP_FILE_PATH,
} from "../state/bootstrap.ts";

/** Describes secret value provider. */
export type SecretValueProvider = (name: string) => string;

/** Describes GitHub repository mutation sink options. */
export interface GitHubRepositoryMutationSinkOptions {
  readonly bootstrap?: RepositoryBootstrap;
  readonly client: GitHubClient;
  readonly owner: string;
  readonly secretValue: SecretValueProvider;
  readonly fileChanges?: FileChangesConfiguration;
  readonly preparedFileChanges?: PreparedFileChanges;
  readonly fileBranch?: string;
  readonly managedFiles?: ManagedFileSnapshot;
  readonly allowClosure?: boolean;
  readonly scope?: ReconciliationScope;
}

type FileOperation = Extract<
  Operation,
  { readonly type: "create-file" | "update-file" | "delete-file" }
>;

interface PreparedFileChanges {
  readonly operations: readonly PlannedFileOperation[];
  applied: boolean;
  error?: unknown;
}

type PlannedFileOperation =
  | FileOperation
  | Extract<Operation, { readonly type: "cleanup-repository-bootstrap" }>;

type EffectiveFileChanges =
  | {
    readonly mode: "direct";
    readonly commitMessage: string;
  }
  | {
    readonly mode: "pull_request";
    readonly commitMessage: string;
    readonly branchPrefix: string;
    readonly title: string;
    readonly introduction: string;
    readonly labels: readonly string[];
  };

/** Describes GitHub repository mutation sink. */
export class GitHubRepositoryMutationSink implements RepositoryMutationSink {
  readonly pullRequests: PullRequestResult[] = [];
  onPullRequest?: (result: PullRequestResult) => void | Promise<void>;
  readonly #client: GitHubClient;
  readonly #owner: string;
  readonly #secretValue: SecretValueProvider;
  readonly #fileChanges: EffectiveFileChanges;
  readonly #preparedFileChanges?: PreparedFileChanges;
  readonly #fileBranch?: string;
  readonly #managedFiles?: ManagedFileSnapshot;
  readonly #allowClosure: boolean;
  readonly #bootstrap?: RepositoryBootstrap;
  readonly #scope: ReconciliationScope;
  #bootstrapSnapshot?: ManagedFileSnapshot;
  #filesReconciled = false;

  constructor(options: GitHubRepositoryMutationSinkOptions) {
    this.#bootstrap = options.bootstrap;
    this.#scope = options.scope ?? "all";
    this.#client = options.client;
    this.#owner = options.owner;
    this.#secretValue = options.secretValue;
    this.#fileChanges = normalizeFileChanges(
      options.fileChanges ?? { mode: "direct" },
    );
    this.#preparedFileChanges = options.preparedFileChanges;
    this.#fileBranch = options.fileBranch;
    this.#managedFiles = options.managedFiles;
    this.#allowClosure = options.allowClosure ?? true;
  }

  prepare(
    _repository: string,
    operations: readonly Operation[],
    fileBranch?: string,
    managedFiles?: ManagedFileSnapshot,
    allowClosure: boolean = this.#allowClosure,
  ): RepositoryMutationSink {
    if (
      this.#scope === "github-only" &&
      operations.some((operation) =>
        isFileOperation(operation) || operation.type === "initialize-repository"
      )
    ) {
      throw new Error(
        "Content and initialization operations are excluded from GitHub-only reconciliation",
      );
    }
    const names = persistedOperationSecretSources(operations);
    const values = new Map<string, string>();

    for (const name of names) {
      const value = this.#secretValue(name);
      if (typeof value !== "string") {
        throw new Error("Missing secret value: " + name);
      }
      values.set(name, value);
    }

    const fileOperations = operations.filter(isFileOperation);
    if (managedFiles) assertNoBootstrapFileDeclarations(managedFiles.files);
    const initialization = operations.find((operation) =>
      operation.type === "initialize-repository"
    );
    if (initialization) {
      if (!this.#bootstrap) {
        throw new Error("Repository bootstrap service is not configured");
      }
      this.#bootstrap.prepare?.(initialization.branch);
    }

    return new GitHubRepositoryMutationSink({
      bootstrap: this.#bootstrap,
      client: this.#client,
      owner: this.#owner,
      secretValue: (name) => {
        const value = values.get(name);
        if (value === undefined) {
          throw new Error("Secret was not prepared: " + name);
        }
        return value;
      },
      fileChanges: toConfiguration(this.#fileChanges),
      fileBranch: fileBranch ?? this.#fileBranch,
      managedFiles: managedFiles ?? this.#managedFiles,
      allowClosure,
      scope: this.#scope,
      ...(fileOperations.length > 0 && {
        preparedFileChanges: {
          operations: fileOperations,
          applied: false,
        },
      }),
    });
  }

  async finish(repository: string): Promise<void> {
    if (this.#scope === "github-only") return;
    if (this.#fileChanges.mode === "pull_request" && !this.#filesReconciled) {
      await this.applyFileChanges(
        repository,
        this.#preparedFileChanges?.operations ?? [],
      );
    }
  }

  async apply(repository: string, operation: Operation): Promise<void> {
    if (
      this.#scope === "github-only" && (
        isFileOperation(operation) || operation.type === "initialize-repository"
      )
    ) {
      throw new Error(
        "Content and initialization operations are excluded from GitHub-only reconciliation",
      );
    }
    switch (operation.type) {
      case "initialize-repository": {
        if (!this.#bootstrap) {
          throw new Error("Repository bootstrap service is not configured");
        }
        await this.#bootstrap.initialize(
          repository,
          operation.branch,
          operation.expectedHead,
        );
        const source = new GitHubRepositoryStateSource(
          this.#client,
          this.#owner,
        );
        const settings = await source.getRepositorySettings(repository);
        if (settings.defaultBranch !== operation.branch) {
          throw new Error(
            "GitHub default branch does not match the bootstrap branch",
          );
        }
        const baseSha = await source.getBranchHead(
          repository,
          operation.branch,
        );
        const bootstrapFile = await source.getFile(
          repository,
          BOOTSTRAP_FILE_PATH,
          baseSha,
        );
        if (!bootstrapFile) {
          throw new Error("Bootstrap file is missing after initialization");
        }
        assertBootstrapFileOwned(bootstrapFile);
        this.#bootstrapSnapshot = {
          branch: operation.branch,
          baseSha,
          bootstrapCleanup: { sha: bootstrapFile.sha },
          files: this.#managedFiles?.files ??
            (this.#preparedFileChanges?.operations ?? []).flatMap((item) =>
              item.type === "create-file" ? [item.file] : []
            ),
        };
        return;
      }
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
          operation.preserveSecrets,
          operation.preserveVariables,
        );
        return;
      case "update-environment":
        await this.applyEnvironment(
          repository,
          operation.environment,
          false,
          operation.collections,
          operation.preserveSecrets,
          operation.preserveVariables,
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
      case "update-file":
      case "delete-file":
      case "cleanup-repository-bootstrap":
        if (this.#preparedFileChanges !== undefined) {
          if (this.#preparedFileChanges.error !== undefined) {
            throw this.#preparedFileChanges.error;
          }

          if (!this.#preparedFileChanges.applied) {
            try {
              await this.applyFileChanges(
                repository,
                this.#preparedFileChanges.operations,
              );
              this.#preparedFileChanges.applied = true;
            } catch (error) {
              this.#preparedFileChanges.error = error;
              throw error;
            }
          }
        } else {
          await this.applyFileChanges(repository, [operation]);
        }
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
      const enabled = settings.enabled ?? current.enabled;

      await this.#client.request("PUT", base, {
        body: enabled
          ? {
            enabled,
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
          }
          : { enabled: false },
      });

      if (enabled && settings.selectedActions !== undefined) {
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
    preserveSecrets: readonly string[] = [],
    preserveVariables: readonly string[] = [],
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
        preserveVariables,
      );
    }

    if (environment.secrets !== undefined) {
      await this.syncEnvironmentSecrets(
        base,
        environment.secrets,
        collections,
        preserveSecrets,
      );
    }
  }

  async syncEnvironmentVariables(
    base: string,
    variables: readonly Variable[],
    collections: "explicit" | "strict",
    preserve: readonly string[] = [],
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
      if (
        removeUndeclared && !desired.has(variable.name) &&
        !preserve.includes(variable.name)
      ) {
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
    secrets: readonly import("../mod.ts").DesiredSecret[],
    collections: "explicit" | "strict",
    preserve: readonly string[] = [],
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
      if (
        removeUndeclared && !desired.has(secret.name) &&
        !preserve.includes(secret.name)
      ) {
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

  async applyFileChanges(
    repository: string,
    plannedOperations: readonly PlannedFileOperation[],
  ): Promise<void> {
    const snapshot = this.#bootstrapSnapshot ?? this.#managedFiles;
    const operations: FileOperation[] = [];
    for (const operation of plannedOperations) {
      if (operation.type !== "cleanup-repository-bootstrap") {
        const path = operation.type === "delete-file"
          ? operation.path
          : operation.file.path;
        if (path === BOOTSTRAP_FILE_PATH) {
          throw new Error(
            "Reserved bootstrap path requires an internal cleanup operation",
          );
        }
        operations.push(operation);
        continue;
      }
      const expected = snapshot?.bootstrapCleanup;
      const expectedSha = expected && "sha" in expected
        ? expected.sha
        : operation.sha;
      if (expectedSha === undefined || snapshot?.baseSha === undefined) {
        throw new Error(
          "Bootstrap cleanup requires a verified initialized file snapshot",
        );
      }
      if (operation.sha !== undefined && operation.sha !== expectedSha) {
        throw new Error("Bootstrap cleanup SHA changed since planning");
      }
      const source = new GitHubRepositoryStateSource(this.#client, this.#owner);
      const file = await source.getFile(
        repository,
        BOOTSTRAP_FILE_PATH,
        snapshot.baseSha,
      );
      if (!file || file.sha !== expectedSha) {
        throw new Error(
          "Bootstrap file changed since planning; build a fresh plan",
        );
      }
      assertBootstrapFileOwned(file);
      operations.push({
        type: "delete-file",
        path: BOOTSTRAP_FILE_PATH,
        sha: file.sha,
      });
    }
    if (this.#fileChanges.mode === "pull_request") {
      if (snapshot === undefined) {
        throw new Error(
          "Pull-request delivery requires a complete managed-file snapshot",
        );
      }
      await reconcileFilePullRequest({
        client: this.#client,
        owner: this.#owner,
        repository,
        snapshot,
        operations,
        commitMessage: this.#fileChanges.commitMessage,
        settings: this.#fileChanges,
        allowClosure: this.#allowClosure,
        onPullRequest: async (result) => {
          this.pullRequests.push(result);
          await this.onPullRequest?.(result);
        },
      }).catch((error) => {
        if (error instanceof GitHubRequestError) {
          throw new Error(
            "GitHub managed-file reconciliation failed (HTTP " + error.status +
              ")",
          );
        }
        throw error;
      });
      this.#filesReconciled = true;
      return;
    }
    if (operations.length === 0) {
      return;
    }

    const repositoryPath = this.repo(repository);
    const metadata = await this.#client.get<
      { readonly default_branch: string }
    >(
      repositoryPath,
    );
    const defaultBranch = snapshot?.branch ?? this.#fileBranch ??
      metadata.default_branch;
    const baseRef = await this.#client.get<{
      readonly object: { readonly sha: string };
    }>(
      repositoryPath + "/git/ref/heads/" + encodePath(defaultBranch),
    );
    const baseSha = baseRef.object.sha;
    if (
      plannedOperations.some((operation) =>
        operation.type === "cleanup-repository-bootstrap"
      ) && snapshot?.baseSha !== baseSha
    ) {
      throw new Error(
        "Bootstrap cleanup target changed since planning; build a fresh plan",
      );
    }
    const baseCommit = await this.#client.get<{
      readonly tree: { readonly sha: string };
    }>(repositoryPath + "/git/commits/" + baseSha);

    for (const operation of operations) {
      await this.validateFileOperation(
        repositoryPath,
        defaultBranch,
        operation,
      );
    }

    const tree: Array<
      { path: string; mode: string; type: string; sha: string | null }
    > = [];
    for (const operation of operations) {
      if (operation.type === "delete-file") {
        tree.push({
          path: operation.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        continue;
      }

      const blob = await this.#client.request<{ readonly sha: string }>(
        "POST",
        repositoryPath + "/git/blobs",
        {
          body: {
            content: operation.file.content,
            encoding: "utf-8",
          },
        },
      );
      tree.push({
        path: operation.file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    const nextTree = await createManagedFileTree(
      this.#client,
      repositoryPath,
      baseCommit.tree.sha,
      tree,
      plannedOperations.some((operation) =>
        operation.type === "cleanup-repository-bootstrap"
      ),
    );
    const message = renderFileChangeText(
      this.#fileChanges.commitMessage,
      this.#owner,
      repository,
    );

    const nextCommit = await this.createFileChangeCommit(
      repositoryPath,
      message,
      nextTree.sha,
      baseSha,
    );
    await this.#client.request(
      "PATCH",
      repositoryPath + "/git/refs/heads/" + encodePath(defaultBranch),
      { body: { sha: nextCommit.sha, force: false } },
    );
  }

  async validateFileOperation(
    repositoryPath: string,
    defaultBranch: string,
    operation: FileOperation,
  ): Promise<void> {
    const path = operation.type === "delete-file"
      ? operation.path
      : operation.file.path;
    const current = await this.#client.request<
      { readonly sha: string } | undefined
    >(
      "GET",
      repositoryPath + "/contents/" + encodePath(path),
      {
        query: { ref: defaultBranch },
        allowNotFound: true,
      },
    );

    if (operation.type === "create-file") {
      if (current !== undefined) {
        throw new Error(
          "Managed file changed since planning: " + path +
            " was created concurrently",
        );
      }
      return;
    }

    if (current === undefined || current.sha !== operation.sha) {
      throw new Error(
        "Managed file changed since planning: " + path,
      );
    }
  }

  private async createFileChangeCommit(
    repositoryPath: string,
    message: string,
    tree: string,
    baseSha: string,
  ): Promise<{ readonly sha: string }> {
    return await this.#client.request<{ readonly sha: string }>(
      "POST",
      repositoryPath + "/git/commits",
      {
        body: {
          message,
          tree,
          parents: [baseSha],
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
  actors: readonly import("../mod.ts").RulesetBypassActor[],
): readonly Record<string, unknown>[] {
  return actors.map((actor) => ({
    ...(actor.actorId !== undefined && { actor_id: actor.actorId }),
    actor_type: pascal(actor.actorType),
    bypass_mode: snake(actor.bypassMode),
  }));
}

function mapRule(
  rule: import("../mod.ts").DesiredRulesetRule,
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
        const mappedRestriction = mapped.dismissal_restriction as
          | Record<string, unknown>
          | undefined;

        mapped.dismissal_restriction = {
          ...mappedRestriction,
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

function isFileOperation(
  operation: Operation,
): operation is PlannedFileOperation {
  return operation.type === "create-file" ||
    operation.type === "update-file" ||
    operation.type === "delete-file" ||
    operation.type === "cleanup-repository-bootstrap";
}

function normalizeFileChanges(
  configuration: FileChangesConfiguration,
): EffectiveFileChanges {
  const commitMessage = configuration.commit?.message ??
    "Octosmith: reconcile managed files";

  if (configuration.mode === "direct") {
    return {
      mode: "direct",
      commitMessage,
    };
  }

  return {
    mode: "pull_request",
    commitMessage,
    branchPrefix: configuration.pullRequest?.branchPrefix ?? "octosmith/",
    title: configuration.pullRequest?.title ??
      "Octosmith: reconcile managed files",
    introduction: configuration.pullRequest?.introduction ?? "",
    labels: configuration.pullRequest?.labels ?? [],
  };
}

function toConfiguration(
  settings: EffectiveFileChanges,
): FileChangesConfiguration {
  return settings.mode === "direct"
    ? {
      mode: "direct",
      commit: { message: settings.commitMessage },
    }
    : {
      mode: "pull_request",
      commit: { message: settings.commitMessage },
      pullRequest: {
        branchPrefix: settings.branchPrefix,
        title: settings.title,
        introduction: settings.introduction,
        labels: settings.labels,
      },
    };
}

function renderFileChangeText(
  template: string,
  organization: string,
  repository: string,
): string {
  return template
    .replaceAll("{organization}", organization)
    .replaceAll("{repository}", repository);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
