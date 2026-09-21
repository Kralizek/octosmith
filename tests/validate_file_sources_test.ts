import { assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  MAX_VALIDATION_FILE_SOURCE_BYTES,
  validateConfigurationFileSources,
} from "../scripts/validate-file-sources.ts";

Deno.test("validation file guard accepts regular files within configuration root", async () => {
  const root = await configurationWithSource("files/managed.txt");

  try {
    await Deno.mkdir(join(root, "files"));
    await Deno.writeTextFile(join(root, "files", "managed.txt"), "hello\n");
    await validateConfigurationFileSources(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validation file guard rejects sources outside configuration root", async () => {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "configuration");
  const outside = join(parent, "outside.txt");

  try {
    await Deno.mkdir(root);
    await writeConfiguration(root, "../outside.txt");
    await Deno.writeTextFile(outside, "outside\n");

    await assertRejects(
      () => validateConfigurationFileSources(root),
      Error,
      "must stay within the configuration root",
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("validation file guard rejects non-regular sources", async () => {
  const root = await configurationWithSource("files");

  try {
    await Deno.mkdir(join(root, "files"));

    await assertRejects(
      () => validateConfigurationFileSources(root),
      Error,
      "must resolve to a regular file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validation file guard rejects oversized sources", async () => {
  const root = await configurationWithSource("files/large.txt");

  try {
    await Deno.mkdir(join(root, "files"));
    await Deno.writeFile(
      join(root, "files", "large.txt"),
      new Uint8Array(MAX_VALIDATION_FILE_SOURCE_BYTES + 1),
    );

    await assertRejects(
      () => validateConfigurationFileSources(root),
      Error,
      "exceeds the",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function configurationWithSource(source: string): Promise<string> {
  const root = await Deno.makeTempDir();
  await writeConfiguration(root, source);
  return root;
}

async function writeConfiguration(root: string, source: string): Promise<void> {
  await Deno.mkdir(join(root, "templates"));
  await Deno.writeTextFile(
    join(root, "octosmith.yml"),
    [
      "version: 1",
      "organization: acme",
      "repositories:",
      "  scope:",
      "    names:",
      "      - sample",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    join(root, "templates", "default.yml"),
    [
      "kind: repository",
      "match:",
      "  names:",
      "    - sample",
      "repository:",
      "  files:",
      "    managed.txt:",
      "      ensure: exact",
      `      source: ${JSON.stringify(source)}`,
      "",
    ].join("\n"),
  );
}
