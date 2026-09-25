import {
  classifyResource,
  type RepositoryMetadata,
} from "./configuration/resolve.ts";
import type { LoadedConfiguration } from "./configuration/load.ts";

/** Describes a resource's template classification, not its execution status. */
export type ResourceInspection =
  & {
    readonly type: string;
    readonly name: string;
  }
  & (
    | { readonly template: string; readonly status: "matched" }
    | { readonly template: null; readonly status: "unmatched" }
  );

/** Describes the resources in scope and their template coverage. */
export interface ResourceInspectionResult {
  readonly resources: readonly ResourceInspection[];
  readonly summary: {
    readonly matched: number;
    readonly unmatched: number;
  };
}

/** Inspect an already discovered resource without resolving desired state. */
export function inspectResource(
  loaded: LoadedConfiguration,
  resource: RepositoryMetadata,
): ResourceInspection {
  const classification = classifyResource(loaded, resource);
  const name = loaded.configuration.organization + "/" + resource.name;
  if (classification.status === "invalid") {
    throw new Error(
      "Resource " + name + " matches multiple templates: " +
        classification.templates.join(", "),
    );
  }
  return { type: "repository", name, ...classification };
}

/** Summarize factual template coverage regardless of unmatched-resource policy. */
export function summarizeResourceInspection(
  resources: readonly ResourceInspection[],
): ResourceInspectionResult {
  return {
    resources,
    summary: {
      matched:
        resources.filter((resource) => resource.status === "matched").length,
      unmatched:
        resources.filter((resource) => resource.status === "unmatched").length,
    },
  };
}

/** Render the resource inspection table and coverage summary. */
export function renderResourceInspection(
  result: ResourceInspectionResult,
): string {
  const rows = [
    ["TYPE", "NAME", "TEMPLATE", "STATUS"],
    ...result.resources.map((resource) => [
      resource.type,
      resource.name,
      resource.template ?? "-",
      resource.status,
    ]),
  ];
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => row[index].length))
  );
  return [
    ...rows.map((row) =>
      row.map((value, index) =>
        index === row.length - 1 ? value : value.padEnd(widths[index])
      )
        .join("  ")
    ),
    "",
    "Summary: " + result.summary.matched + " matched, " +
    result.summary.unmatched + " unmatched",
  ].join("\n");
}
