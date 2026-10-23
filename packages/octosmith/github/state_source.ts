import type {
  CurrentActionsOidcSettings,
  CurrentActionsSettings,
  CurrentFile,
  CurrentRepositorySettings,
  CurrentRuleset,
  CustomPropertyValue,
  Environment,
  SecretName,
  TeamPermission,
  Variable,
} from "../mod.ts";

/** Git history availability, independent of any requested execution branch. */
export type RepositoryHistory =
  | { readonly initialized: false }
  | {
    readonly initialized: true;
    readonly branch: string;
    readonly head: string;
  };

/** Describes repository state source. */
export interface RepositoryStateSource {
  getRepositorySettings(repository: string): Promise<CurrentRepositorySettings>;

  getRepositoryHistory?(
    repository: string,
    defaultBranch: string,
  ): Promise<RepositoryHistory>;

  getCustomProperties(
    repository: string,
  ): Promise<Readonly<Record<string, CustomPropertyValue>>>;

  getActionsSettings(
    repository: string,
  ): Promise<Omit<CurrentActionsSettings, "oidc">>;

  getActionsOidcSettings(
    repository: string,
  ): Promise<CurrentActionsOidcSettings>;

  getTeams(repository: string): Promise<readonly TeamPermission[]>;

  getActionsSecrets(repository: string): Promise<readonly SecretName[]>;

  getActionsVariables(repository: string): Promise<readonly Variable[]>;

  getDependabotSecrets(repository: string): Promise<readonly SecretName[]>;

  getRulesets(repository: string): Promise<readonly CurrentRuleset[]>;

  getEnvironments(repository: string): Promise<readonly Environment[]>;

  getBranchHead(repository: string, branch: string): Promise<string>;

  getFile(
    repository: string,
    path: string,
    branch?: string,
  ): Promise<CurrentFile | undefined>;
}
