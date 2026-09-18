import type {
  Environment,
  SecretName,
  TeamPermission,
  Variable,
} from "./common.ts";
import type {
  CurrentRepositorySettings,
  DesiredRepositorySettings,
} from "./repository.ts";
import type { CurrentRuleset, DesiredRuleset } from "./rulesets.ts";

export interface CurrentState {
  readonly repository: string;
  readonly settings: CurrentRepositorySettings;
  readonly teams: readonly TeamPermission[];
  readonly secrets: readonly SecretName[];
  readonly variables: readonly Variable[];
  readonly rulesets: readonly CurrentRuleset[];
  readonly environments: readonly Environment[];
  readonly files: readonly CurrentFile[];
}

export interface DesiredState {
  readonly repository: string;
  readonly template: string;
  readonly settings?: DesiredRepositorySettings;
  readonly teams?: readonly TeamPermission[];
  readonly secrets?: readonly SecretName[];
  readonly variables?: readonly Variable[];
  readonly rulesets?: readonly DesiredRuleset[];
  readonly environments?: readonly Environment[];
  readonly files?: readonly DesiredFile[];
}

export interface CurrentFile {
  readonly path: string;
  readonly content: string;
  readonly sha: string;
}

export type DesiredFile =
  | {
    readonly path: string;
    readonly ensure: "exact";
    readonly content: string;
  }
  | {
    readonly path: string;
    readonly ensure: "absent";
  };
