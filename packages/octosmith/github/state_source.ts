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

/** Describes repository state source. */
export interface RepositoryStateSource {
  getRepositorySettings(repository: string): Promise<CurrentRepositorySettings>;

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

  getFile(repository: string, path: string): Promise<CurrentFile | undefined>;
}
