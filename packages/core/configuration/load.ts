import { join } from "@std/path";
import { parse } from "@std/yaml";
import type { Configuration, RepositoryTemplate } from "./types.ts";

export interface LoadedConfiguration {
  readonly root: string;
  readonly configuration: Configuration;
  readonly templates: Readonly<Record<string, RepositoryTemplate>>;
}

export async function loadConfigurationDirectory(
  root: string,
): Promise<LoadedConfiguration> {
  const configuration = await loadYaml<Configuration>(
    join(root, "octosmith.yml"),
  );

  const templatesDirectory = join(root, "templates");
  const templates: Record<string, RepositoryTemplate> = {};

  for await (const entry of Deno.readDir(templatesDirectory)) {
    if (!entry.isFile || !/\.ya?ml$/i.test(entry.name)) {
      continue;
    }

    const name = entry.name.replace(/\.ya?ml$/i, "");
    templates[name] = await loadYaml<RepositoryTemplate>(
      join(templatesDirectory, entry.name),
    );
  }

  return {
    root,
    configuration,
    templates,
  };
}

async function loadYaml<T>(path: string): Promise<T> {
  return normalizeYaml(
    parse(await Deno.readTextFile(path)),
  ) as T;
}

function normalizeYaml(
  value: unknown,
  path: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeYaml(item, path));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const preserveKeys = path.at(-1) === "properties" ||
    path.at(-1) === "customProperties" ||
    path.at(-1) === "files";

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      const normalizedKey = preserveKeys ? key : camelizeKey(key);

      return [
        normalizedKey,
        normalizeYaml(child, [...path, normalizedKey]),
      ];
    }),
  );
}

function camelizeKey(key: string): string {
  return key.replace(
    /_([a-z])/g,
    (_, letter: string) => letter.toUpperCase(),
  );
}
