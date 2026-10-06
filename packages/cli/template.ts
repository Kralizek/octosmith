import type { LoadedConfiguration } from "@octosmith/octosmith";

/** Resolve and validate a template filter against the loaded configuration. */
export function resolveTemplateIdentity(
  loaded: LoadedConfiguration,
  template: string,
): string {
  if (template.length === 0) {
    throw new Error("Template filter must not be empty");
  }

  const identity = template.startsWith("repository:")
    ? template
    : "repository:" + template;
  if (loaded.templates[identity] === undefined) {
    throw new Error("Unknown template: " + template);
  }
  return identity;
}
