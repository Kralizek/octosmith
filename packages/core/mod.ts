/**
 * Core models and apply primitives for OctoSmith.
 *
 * @module
 */

export * from "./configuration/mod.ts";
export * from "./plan/mod.ts";
export * from "./report/mod.ts";
export * from "./state/mod.ts";
export * from "./types.ts";

/** The apply modes supported by OctoSmith. */
export type ApplyMode = "plan" | "apply";
