import { join } from "@std/path";
import { parse } from "@std/yaml";
import type {
  Configuration,
  RepositoryTemplate,
} from "../models/configuration.ts";

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
  return camelizeKeys(
    parse(await Deno.readTextFile(path)),
  ) as T;
}

function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelizeKeys);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      camelizeKeys(child),
    ]),
  );
}
