import { assertEquals, assertStringIncludes } from "@std/assert";
import { main } from "../packages/cli/mod.ts";

Deno.test("validate succeeds offline without GITHUB_TOKEN", async () => {
  const root = await validConfiguration();
  const previousToken = Deno.env.get("GITHUB_TOKEN");
  const originalFetch = globalThis.fetch;
  const output: string[] = [];
  let fetchCalls = 0;

  try {
    Deno.env.delete("GITHUB_TOKEN");
    globalThis.fetch = ((_input, _init) => {
      fetchCalls++;
      return Promise.reject(new Error("fetch must not be called"));
    }) as typeof globalThis.fetch;

    assertEquals(
      await main(
        ["template", "validate", "--path", root],
        { write: (value) => output.push(value) },
      ),
      0,
    );
    assertEquals(fetchCalls, 0);
    assertEquals(output, ["Configuration is valid."]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) {
      Deno.env.delete("GITHUB_TOKEN");
    } else {
      Deno.env.set("GITHUB_TOKEN", previousToken);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate emits machine-readable success", async () => {
  const root = await validConfiguration();
  const output: string[] = [];

  try {
    assertEquals(
      await main(
        ["template", "validate", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      0,
    );

    assertEquals(JSON.parse(output[0]), { valid: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate fails when a managed file source is missing", async () => {
  const root = await validConfiguration(false);
  const errors: string[] = [];
  const originalError = console.error;

  try {
    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    assertEquals(await main(["template", "validate", "--path", root]), 1);
    assertStringIncludes(errors.join("\n"), "managed.txt");
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate rejects overlapping repository templates", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];
  const originalError = console.error;

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
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
      root + "/templates/wildcard.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        '  names: ["*"]',
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/sample.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository: {}",
        "",
      ].join("\n"),
    );

    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    assertEquals(await main(["template", "validate", "--path", root]), 1);
    assertStringIncludes(
      errors.join("\n"),
      "templates can overlap within configured scope",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate rejects literal scoped repositories without a template", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];
  const originalError = console.error;

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
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
      root + "/templates/other.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - other",
        "repository: {}",
        "",
      ].join("\n"),
    );

    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    assertEquals(await main(["template", "validate", "--path", root]), 1);
    assertStringIncludes(
      errors.join("\n"),
      "cannot match any template within configured scope",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate rejects overlaps that require combined metadata", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];
  const originalError = console.error;

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        '    names: ["*"]',
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/team.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  teams:",
        "    - platform",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/property.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  properties:",
        "    tier: backend",
        "repository: {}",
        "",
      ].join("\n"),
    );

    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    assertEquals(await main(["template", "validate", "--path", root]), 1);
    assertStringIncludes(errors.join("\n"), "templates can overlap");
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate accepts literal scope when metadata could satisfy template", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
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
      root + "/templates/team.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "  teams:",
        "    - platform",
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(await main(["template", "validate", "--path", root]), 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate allows incompatible metadata selectors", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        '    names: ["*"]',
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/public.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  visibility: public",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/private.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  visibility: private",
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(await main(["template", "validate", "--path", root]), 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate allows template overlap outside configured scope", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        "    names:",
        "      - api-*",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/api.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - api-*",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/web.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - web-*",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/all-web.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - web-*",
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(await main(["template", "validate", "--path", root]), 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate rejects scope metadata incompatible with all templates", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];
  const originalError = console.error;

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        "    properties:",
        "      tier: backend",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/frontend.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  properties:",
        "    tier: frontend",
        "repository: {}",
        "",
      ].join("\n"),
    );

    console.error = (...values: unknown[]) =>
      errors.push(values.map(String).join(" "));

    assertEquals(await main(["template", "validate", "--path", root]), 1);
    assertStringIncludes(
      errors.join("\n"),
      "Configured repository scope cannot match any template",
    );
  } finally {
    console.error = originalError;
    await Deno.remove(root, { recursive: true });
  }
});

async function validConfiguration(includeManagedFile = true): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(root + "/templates");
  await Deno.mkdir(root + "/files");

  await Deno.writeTextFile(
    root + "/octosmith.yml",
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

  if (includeManagedFile) {
    await Deno.writeTextFile(root + "/files/managed.txt", "hello\n");
  }

  await Deno.writeTextFile(
    root + "/templates/default.yml",
    [
      "version: 1",
      "kind: repository",
      "match:",
      "  names:",
      "    - sample",
      "repository:",
      "  files:",
      "    managed.txt:",
      "      ensure: exact",
      "      source: files/managed.txt",
      "",
    ].join("\n"),
  );

  return root;
}
