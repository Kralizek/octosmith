import { dirname, extname, isAbsolute, join, relative, resolve } from "@std/path";
import { parse } from "@std/yaml";
import { Ajv2020, type ValidateFunction } from "ajv/2020";
import type {
  Configuration,
  RepositoryConfiguration,
  RepositoryFragment,
  RepositoryTemplate,
} from "./types.ts";
import configurationSchema from "./schemas/octosmith.schema.json" with {
  type: "json",
};
import templateSchema from "./schemas/template.schema.json" with {
  type: "json",
};
import fragmentSchema from "./schemas/fragment.schema.json" with {
  type: "json",
};
import repositorySchema from "./schemas/resources/repository.schema.json" with {
  type: "json",
};
import repositorySelectorSchema from "./schemas/selectors/repository.schema.json" with {
  type: "json",
};

const MAX_CONFIGURATION_FILE_SIZE = 10 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 32;

const validator = new Ajv2020({ allErrors: true, strict: false });
validator.addSchema(repositorySchema);
validator.addSchema(repositorySelectorSchema);
const validateConfiguration = validator.compile(configurationSchema);
const validateTemplate = validator.compile(templateSchema);
const validateFragment = validator.compile(fragmentSchema);

/** Describes loaded configuration. */
export interface LoadedConfiguration {
  readonly root: string;
  readonly configuration: Configuration;
  readonly templates: Readonly<Record<string, RepositoryTemplate>>;
}

/** Load and validate an Octosmith configuration directory. */
export async function loadConfigurationDirectory(
  root: string,
): Promise<LoadedConfiguration> {
  const configuration = await loadYaml<Configuration>(
    join(root, "octosmith.yml"),
    validateConfiguration,
  );

  const canonicalRoot = await Deno.realPath(root);
  const templatesDirectory = join(root, "templates");
  const templatesDirectoryInfo = await Deno.lstat(templatesDirectory);
  if (!templatesDirectoryInfo.isDirectory) {
    throw new Error(
      "Templates path must be a real directory: " + templatesDirectory,
    );
  }

  const templates: Record<string, RepositoryTemplate> = {};

  for await (const path of walkTemplateFiles(templatesDirectory)) {
    const rawTemplate = await loadYaml<RepositoryTemplate>(
      path,
      validateTemplate,
    );
    const template = await composeRepositoryTemplate(
      canonicalRoot,
      path,
      rawTemplate,
    );
    const relativePath = relative(templatesDirectory, path)
      .replaceAll("\\", "/");
    const extension = extname(relativePath);
    if (extension.length === 0) {
      throw new Error(
        "Template filename must include a name before the YAML extension: " +
          relativePath,
      );
    }

    const id = relativePath.slice(0, -extension.length);
    const identity = template.kind + ":" + id;

    if (templates[identity] !== undefined) {
      throw new Error("Duplicate template identity: " + identity);
    }

    templates[identity] = template;
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

async function* walkTemplateFiles(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);

    if (entry.isDirectory) {
      yield* walkTemplateFiles(path);
      continue;
    }

    if (entry.isFile && /\.ya?ml$/i.test(entry.name)) {
      yield path;
    }
  }
}


async function composeRepositoryTemplate(
  configurationRoot: string,
  templatePath: string,
  template: RepositoryTemplate,
): Promise<RepositoryTemplate> {
  if (template.includes === undefined) {
    return template;
  }

  const visited = new Set<string>();
  const canonicalTemplatePath = await Deno.realPath(templatePath);
  let repository: RepositoryConfiguration = {};

  for (const include of template.includes) {
    repository = mergeRepositoryConfigurations(
      repository,
      await loadRepositoryFragment(
        configurationRoot,
        canonicalTemplatePath,
        include,
        visited,
        [canonicalTemplatePath],
        1,
      ),
    );
  }

  return {
    ...template,
    repository: mergeRepositoryConfigurations(repository, template.repository),
  };
}

async function loadRepositoryFragment(
  configurationRoot: string,
  includingPath: string,
  include: string,
  visited: Set<string>,
  chain: readonly string[],
  depth: number,
): Promise<RepositoryConfiguration> {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(
      "Maximum fragment include depth of " + MAX_INCLUDE_DEPTH +
        " exceeded. Include chain: " +
        formatIncludeChain(chain),
    );
  }

  const requestedPath = resolve(dirname(includingPath), include);
  const canonicalPath = await Deno.realPath(requestedPath);

  if (!isWithinConfigurationRoot(configurationRoot, canonicalPath)) {
    throw new Error(
      "Fragment include escapes the configuration root: " + include,
    );
  }

  if (chain.includes(canonicalPath)) {
    throw new Error(
      "Cyclic fragment include detected. Include chain: " +
        formatIncludeChain([...chain, canonicalPath]),
    );
  }

  if (visited.has(canonicalPath)) {
    return {};
  }

  visited.add(canonicalPath);

  const fragment = await loadYaml<RepositoryFragment>(
    canonicalPath,
    validateFragment,
  );

  if (fragment.resource !== "repository") {
    throw new Error(
      'Fragment resource mismatch in ' + canonicalPath +
        ': expected "repository", found "' + fragment.resource + '"',
    );
  }

  let repository: RepositoryConfiguration = {};
  const nextChain = [...chain, canonicalPath];

  for (const nestedInclude of fragment.includes ?? []) {
    repository = mergeRepositoryConfigurations(
      repository,
      await loadRepositoryFragment(
        configurationRoot,
        canonicalPath,
        nestedInclude,
        visited,
        nextChain,
        depth + 1,
      ),
    );
  }

  if (fragment.repository !== undefined) {
    repository = mergeRepositoryConfigurations(
      repository,
      fragment.repository,
    );
  }

  return repository;
}

function mergeRepositoryConfigurations(
  earlier: RepositoryConfiguration,
  later: RepositoryConfiguration,
): RepositoryConfiguration {
  return mergeValues(earlier, later) as RepositoryConfiguration;
}

function mergeValues(earlier: unknown, later: unknown): unknown {
  if (
    earlier !== null &&
    later !== null &&
    typeof earlier === "object" &&
    typeof later === "object" &&
    !Array.isArray(earlier) &&
    !Array.isArray(later)
  ) {
    const result: Record<string, unknown> = {
      ...(earlier as Record<string, unknown>),
    };

    for (const [key, value] of Object.entries(
      later as Record<string, unknown>,
    )) {
      result[key] = key in result
        ? mergeValues(result[key], value)
        : value;
    }

    return result;
  }

  return later;
}

function isWithinConfigurationRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !relativePath.startsWith("..\\"));
}

function formatIncludeChain(paths: readonly string[]): string {
  return paths.join(" -> ");
}
