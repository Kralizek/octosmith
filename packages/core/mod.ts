/**
 * Core models and reconciliation primitives for OctoSmith.
 *
 * @module
 */

export * from "./configuration/mod.ts";
export * from "./plan/mod.ts";
export * from "./report/mod.ts";
export * from "./state/mod.ts";
export * from "./types.ts";

/** The reconciliation modes supported by OctoSmith. */
export type ReconciliationMode = "plan" | "apply";
