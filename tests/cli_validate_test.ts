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

    assertEquals(JSON.parse(output[0]), { valid: true, diagnostics: [] });
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
        "    include:",
        "      names:",
        "        - sample",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/wildcard.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        '    names: ["*"]',
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
        "  include:",
        "    names:",
        "      - sample",
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
        "    include:",
        "      names:",
        "        - sample",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/other.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    names:",
        "      - other",
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
        "    include:",
        '      names: ["*"]',
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/team.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    teams:",
        "      - platform",
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
        "  include:",
        "    properties:",
        "      tier: backend",
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
        "    include:",
        "      names:",
        "        - sample",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/team.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    names:",
        "      - sample",
        "    teams:",
        "      - platform",
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(await main(["template", "validate", "--path", root]), 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate still detects overlap when an unrelated exclusion exists", async () => {
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
        "    include: all",
        "",
      ].join("\n"),
    );
    for (const [name, excluded] of [["one", true], ["two", false]] as const) {
      await Deno.writeTextFile(
        root + `/templates/${name}.yml`,
        [
          "version: 1",
          "kind: repository",
          "match:",
          "  include:",
          '    names: ["service-*"]',
          ...(excluded
            ? [
              "  exclude:",
              '    names: ["legacy-*"]',
            ]
            : []),
          "repository: {}",
          "",
        ].join("\n"),
      );
    }

    const errors: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...values: unknown[]) =>
        errors.push(values.map(String).join(" "));
      assertEquals(await main(["template", "validate", "--path", root]), 1);
      assertStringIncludes(errors.join("\n"), "templates can overlap");
    } finally {
      console.error = originalError;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate detects overlap through an alternate visibility witness", async () => {
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
        "    include: all",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/one.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    visibility:",
        "      - public",
        "      - private",
        "  exclude:",
        "    visibility: public",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/two.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    visibility:",
        "      - public",
        "      - private",
        "repository: {}",
        "",
      ].join("\n"),
    );

    const errors: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...values: unknown[]) =>
        errors.push(values.map(String).join(" "));
      assertEquals(await main(["template", "validate", "--path", root]), 1);
      assertStringIncludes(errors.join("\n"), "templates can overlap");
    } finally {
      console.error = originalError;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate rejects scope when exclusions make every template unreachable", async () => {
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
        "    include: all",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/default.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include: all",
        "  exclude:",
        '    names: ["*"]',
        "repository: {}",
        "",
      ].join("\n"),
    );

    const errors: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...values: unknown[]) =>
        errors.push(values.map(String).join(" "));
      assertEquals(await main(["template", "validate", "--path", root]), 1);
      assertStringIncludes(
        errors.join("\n"),
        "Configured repository scope cannot match any template",
      );
    } finally {
      console.error = originalError;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate rejects exclusions covering every non-empty repository name", async () => {
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
        "    include: all",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/default.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include: all",
        "  exclude:",
        '    names: ["?*"]',
        "repository: {}",
        "",
      ].join("\n"),
    );

    const errors: string[] = [];
    const originalError = console.error;
    try {
      console.error = (...values: unknown[]) =>
        errors.push(values.map(String).join(" "));
      assertEquals(await main(["template", "validate", "--path", root]), 1);
      assertStringIncludes(
        errors.join("\n"),
        "Configured repository scope cannot match any template",
      );
    } finally {
      console.error = originalError;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate materializes templates independently from exclusions", async () => {
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
        "    include: all",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/default.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include: all",
        "  exclude:",
        '    names: ["validation-*"]',
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
        "    include:",
        '      names: ["*"]',
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/public.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    visibility: public",
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
        "  include:",
        "    visibility: private",
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
        "    include:",
        "      names:",
        "        - api-*",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/api.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    names:",
        "      - api-*",
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
        "  include:",
        "    names:",
        "      - web-*",
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
        "  include:",
        "    names:",
        "      - web-*",
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
        "    include:",
        "      properties:",
        "        tier: backend",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/frontend.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    properties:",
        "      tier: frontend",
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
      "    include:",
      "      names:",
      "        - sample",
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
      "  include:",
      "    names:",
      "      - sample",
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
