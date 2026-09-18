import type { PropertyValue } from "./common.ts";
import type { DesiredRepositorySettings } from "./repository.ts";
import type { DesiredRuleset } from "./rulesets.ts";

export interface Configuration {
  readonly version: 1;
  readonly organization: string;
  readonly scope: RepositorySelector;
}

export interface RepositorySelector {
  readonly names?: readonly string[];
  readonly teams?: readonly string[];
  readonly properties?: Readonly<Record<string, PropertyValue>>;
}

export interface RepositoryTemplate {
  readonly match: RepositorySelector;
  readonly repository?: RepositoryConfiguration;
  readonly rulesets?: readonly DesiredRuleset[];
  readonly environments?: readonly EnvironmentConfiguration[];
  readonly files?: Readonly<Record<string, FileConfiguration>>;
}

export interface RepositoryConfiguration {
  readonly settings?: DesiredRepositorySettings;
  readonly teams?: readonly TeamPermissionConfiguration[];
  readonly secrets?: readonly string[];
  readonly variables?: readonly string[];
}

export interface TeamPermissionConfiguration {
  readonly name: string;
  readonly permission: string;
}

export interface EnvironmentConfiguration {
  readonly name: string;
  readonly secrets?: readonly string[];
  readonly variables?: readonly string[];
}

export type FileConfiguration =
  | {
    readonly ensure: "exact";
    readonly source: string;
  }
  | {
    readonly ensure: "absent";
  };
