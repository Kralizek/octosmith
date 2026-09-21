import { join } from "@std/path";
import { parse } from "@std/yaml";
import { Ajv2020, type ValidateFunction } from "ajv/2020";
import type { Configuration, RepositoryTemplate } from "./types.ts";
import configurationSchema from "./schemas/octosmith.schema.json" with {
  type: "json",
};
import templateSchema from "./schemas/template.schema.json" with {
  type: "json",
};

const MAX_CONFIGURATION_FILE_SIZE = 10 * 1024 * 1024;

const validator = new Ajv2020({ allErrors: true, strict: false });
const validateConfiguration = validator.compile(configurationSchema);
const validateTemplate = validator.compile(templateSchema);

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
    validateConfiguration,
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
      validateTemplate,
    );
  }

  return {
    root,
    configuration,
    templates,
  };
}

async function loadYaml<T>(
  path: string,
  validate: ValidateFunction,
): Promise<T> {
  const info = await Deno.lstat(path);
  if (!info.isFile) {
    throw new Error("Configuration file must be a regular file: " + path);
  }

  if (info.size > MAX_CONFIGURATION_FILE_SIZE) {
    throw new Error(
      "Configuration file exceeds the maximum size of " +
        MAX_CONFIGURATION_FILE_SIZE +
        " bytes: " +
        path,
    );
  }

  const value = parse(await Deno.readTextFile(path));

  if (!validate(value)) {
    const errors = validate.errors?.map((error) =>
      (error.instancePath || "/") + " " + error.message +
      (error.keyword === "additionalProperties"
        ? ": " + error.params.additionalProperty
        : "")
    ).join("; ");
    throw new Error("Invalid configuration in " + path + ": " + errors);
  }

  return normalizeYaml(value) as T;
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
