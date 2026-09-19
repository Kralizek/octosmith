import type {
  CollectionReconciliationMode,
  DesiredSecret,
  Environment,
  TeamPermission,
  Variable,
} from "../types.ts";
import type {
  CurrentActions,
  CurrentCopilotSettings,
  CurrentDependabot,
  CustomPropertyValue,
  DesiredActions,
  DesiredDependabot,
} from "./resources.ts";
import type {
  CurrentRepositorySettings,
  DesiredRepositorySettings,
} from "./repository.ts";
import type { CurrentRuleset, DesiredRuleset } from "./rulesets.ts";

export interface CurrentState {
  readonly repository: string;
  readonly settings: CurrentRepositorySettings;
  readonly customProperties: Readonly<Record<string, CustomPropertyValue>>;
  readonly actions: CurrentActions;
  readonly dependabot: CurrentDependabot;
  readonly copilot?: CurrentCopilotSettings;
  readonly teams: readonly TeamPermission[];
  readonly rulesets: readonly CurrentRuleset[];
  readonly environments: readonly Environment[];
  readonly files: readonly CurrentFile[];
}

export interface DesiredState {
  readonly repository: string;
  readonly template: string;
  readonly collections?: CollectionReconciliationMode;
  readonly settings?: DesiredRepositorySettings;
  readonly customProperties?: Readonly<Record<string, CustomPropertyValue>>;
  readonly actions?: DesiredActions;
  readonly dependabot?: DesiredDependabot;
  readonly teams?: readonly TeamPermission[];
  readonly rulesets?: readonly DesiredRuleset[];
  readonly environments?: readonly DesiredEnvironment[];
  readonly files?: readonly DesiredFile[];
}

export interface DesiredEnvironment {
  readonly name: string;
  readonly secrets?: readonly DesiredSecret[];
  readonly variables?: readonly Variable[];
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
    readonly ensure: "exists";
    readonly content: string;
  }
  | {
    readonly path: string;
    readonly ensure: "absent";
  };
