import type {
  Environment,
  Ruleset,
  SecretName,
  TeamPermission,
  Variable,
} from "./common.ts";

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
  readonly settings: DesiredRepositorySettings;
  readonly teams: readonly TeamPermission[];
  readonly secrets: readonly SecretName[];
  readonly variables: readonly Variable[];
  readonly rulesets: readonly Ruleset[];
  readonly environments: readonly Environment[];
  readonly files: readonly DesiredFile[];
}

export interface CurrentRepositorySettings {
  readonly hasWiki: boolean;
  readonly hasIssues: boolean;
  readonly hasProjects: boolean;
  readonly hasDiscussions: boolean;
  readonly deleteBranchOnMerge: boolean;
  readonly merge: CurrentMergeSettings;
}

export interface DesiredRepositorySettings {
  readonly hasWiki?: boolean;
  readonly hasIssues?: boolean;
  readonly hasProjects?: boolean;
  readonly hasDiscussions?: boolean;
  readonly deleteBranchOnMerge?: boolean;
  readonly merge?: DesiredMergeSettings;
}

export interface CurrentMergeSettings {
  readonly mergeCommit: boolean;
  readonly rebase: boolean;
  readonly squash: boolean;
  readonly squashCommitTitle?: string;
}

export interface DesiredMergeSettings {
  readonly mergeCommit?: boolean;
  readonly rebase?: boolean;
  readonly squash?: boolean;
  readonly squashCommitTitle?: string;
}

export interface CurrentRuleset extends Ruleset {
  readonly id: number;
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
