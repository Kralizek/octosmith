/**
 * Composition overrides for schema-defined arrays.
 *
 * Arrays replace wholesale by default; only paths listed here can merge
 * entries by a stable identity. New primary repository collections should be
 * reviewed in tests/array_composition_policies_test.ts. Nested arrays remain
 * opt-in and need no policy when replacement is appropriate.
 */
export type ArrayCompositionPolicy =
  | "replace"
  | "name"
  | "type"
  | "secretDestination"
  | "variableDestination";

/** Merge keys for opted-in arrays, with replacement as the runtime fallback. */
export const arrayCompositionPolicies: Readonly<
  Record<string, ArrayCompositionPolicy>
> = {
  postCreateCommands: "replace",
  teams: "name",
  rulesets: "name",
  environments: "name",
  "actions.secrets": "secretDestination",
  "actions.variables": "variableDestination",
  "dependabot.secrets": "secretDestination",
  "environments.*.secrets": "secretDestination",
  "environments.*.variables": "variableDestination",
  "rulesets.*.rules": "type",
};
