import { isAbsolute, relative, resolve } from "@std/path";
import { loadConfigurationDirectory } from "../packages/octosmith/configuration/load.ts";

export const MAX_VALIDATION_FILE_SOURCE_BYTES = 1024 * 1024;

export async function validateConfigurationFileSources(
  root: string,
): Promise<void> {
  const loaded = await loadConfigurationDirectory(root);
  const canonicalRoot = await Deno.realPath(loaded.root);

  for (const [templateName, template] of Object.entries(loaded.templates)) {
    for (
      const [targetPath, file] of Object.entries(
        template.repository.files ?? {},
      )
    ) {
      if (file.ensure === "absent") {
        continue;
      }

      const candidate = resolve(canonicalRoot, file.source);
      let source: string;

      try {
        source = await Deno.realPath(candidate);
      } catch {
        throw new Error(
          `Managed file source ${file.source} for ${templateName}:${targetPath} does not exist`,
        );
      }

      const relativeSource = relative(canonicalRoot, source);
      if (
        isAbsolute(relativeSource) ||
        relativeSource === ".." ||
        relativeSource.startsWith("../") ||
        relativeSource.startsWith("..\\")
      ) {
        throw new Error(
          `Managed file source ${file.source} for ${templateName}:${targetPath} must stay within the configuration root`,
        );
      }

      const info = await Deno.stat(source);
      if (!info.isFile) {
        throw new Error(
          `Managed file source ${file.source} for ${templateName}:${targetPath} must resolve to a regular file`,
        );
      }

      if (info.size > MAX_VALIDATION_FILE_SOURCE_BYTES) {
        throw new Error(
          `Managed file source ${file.source} for ${templateName}:${targetPath} exceeds the ${MAX_VALIDATION_FILE_SOURCE_BYTES}-byte validation limit`,
        );
      }
    }
  }
}

if (import.meta.main) {
  await validateConfigurationFileSources(Deno.args[0] ?? ".");
}
