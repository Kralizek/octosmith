/**
 * Octosmith domain models, planning, reporting, and GitHub integration.
 *
 * @module
 */

export * from "./configuration/mod.ts";
export * from "./plan/mod.ts";
export * from "./report/mod.ts";
export * from "./state/mod.ts";
export * from "./types.ts";
export * from "./github/mod.ts";
export * from "./inspection.ts";

/** The apply modes supported by Octosmith. */
export type ApplyMode = "plan" | "apply";
