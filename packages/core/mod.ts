/**
 * Core models and reconciliation primitives for OctoSmith.
 *
 * @module
 */

export * from "./configuration/mod.ts";
export * from "./models/mod.ts";

/** The reconciliation modes supported by OctoSmith. */
export type ReconciliationMode = "plan" | "apply";
