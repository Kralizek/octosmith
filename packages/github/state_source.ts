import type {
  CurrentActionsSettings,
  CurrentFile,
  CurrentRepositorySettings,
  CurrentRuleset,
  CustomPropertyValue,
  Environment,
  SecretName,
  TeamPermission,
  Variable,
} from "@octosmith/core";

export interface RepositoryStateSource {
  getRepositorySettings(repository: string): Promise<CurrentRepositorySettings>;

  getCustomProperties(
    repository: string,
  ): Promise<Readonly<Record<string, CustomPropertyValue>>>;

  getActionsSettings(repository: string): Promise<CurrentActionsSettings>;

  getTeams(repository: string): Promise<readonly TeamPermission[]>;

  getActionsSecrets(repository: string): Promise<readonly SecretName[]>;

  getActionsVariables(repository: string): Promise<readonly Variable[]>;

  getDependabotSecrets(repository: string): Promise<readonly SecretName[]>;

  getRulesets(repository: string): Promise<readonly CurrentRuleset[]>;

  getEnvironments(repository: string): Promise<readonly Environment[]>;

  getFile(repository: string, path: string): Promise<CurrentFile | undefined>;
}
