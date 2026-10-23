import type {
  CollectionManagementMode,
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

/** Describes current state. */
export interface CurrentState {
  readonly repository: string;
  /** Explicitly records repositories with no Git history. */
  readonly history?: { readonly initialized: boolean };
  /** Internal lifecycle state, separate from user-managed files. */
  readonly bootstrapFile?: CurrentFile;
  /** Owned root commit awaiting default-branch completion after partial bootstrap. */
  readonly bootstrapBranchPending?: {
    readonly branch: string;
    readonly head: string;
  };
  readonly settings: CurrentRepositorySettings;
  readonly customProperties: Readonly<Record<string, CustomPropertyValue>>;
  readonly actions: CurrentActions;
  readonly dependabot: CurrentDependabot;
  readonly copilot?: CurrentCopilotSettings;
  readonly teams: readonly TeamPermission[];
  readonly rulesets: readonly CurrentRuleset[];
  readonly environments: readonly Environment[];
  /** Branch used for the managed-file snapshot; defaults to settings.defaultBranch. */
  readonly filesBranch?: string;
  /** Immutable target commit for authoritative managed-file reconciliation. */
  readonly filesBaseSha?: string;
  readonly files: readonly CurrentFile[];
}

/** Describes desired state. */
export interface DesiredState {
  readonly repository: string;
  readonly defaultBranchDrift?: "ignore" | "enforce";
  readonly fileDelivery?: "direct" | "pull_request";
  readonly template: string;
  readonly templateName?: string;
  readonly secretsExcluded?: true;
  readonly collections?: CollectionManagementMode;
  readonly settings?: DesiredRepositorySettings;
  readonly customProperties?: Readonly<Record<string, CustomPropertyValue>>;
  readonly actions?: DesiredActions;
  readonly dependabot?: DesiredDependabot;
  readonly teams?: readonly TeamPermission[];
  readonly rulesets?: readonly DesiredRuleset[];
  readonly environments?: readonly DesiredEnvironment[];
  readonly files?: readonly DesiredFile[];
}

/** Describes desired environment. */
export interface DesiredEnvironment {
  readonly name: string;
  readonly secrets?: readonly DesiredSecret[];
  readonly variables?: readonly Variable[];
}

/** Describes current file. */
export interface CurrentFile {
  readonly path: string;
  readonly content: string;
  readonly sha: string;
}

/** Describes desired file. */
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
