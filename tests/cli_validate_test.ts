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

Deno.test("validate quiet suppresses success and keeps failures on stderr", async () => {
  const validRoot = await validConfiguration();
  const invalidRoot = await Deno.makeTempDir();
  const output: string[] = [];
  const errors: string[] = [];

  try {
    await Deno.mkdir(invalidRoot + "/templates");
    await Deno.writeTextFile(
      invalidRoot + "/octosmith.yml",
      "version: 1\norganization: acme\nrepositories:\n  scope:\n    include: all\n",
    );
    await Deno.writeTextFile(
      invalidRoot + "/templates/sample.yml",
      "version: 1\nkind: invalid\n",
    );

    assertEquals(
      await main(["template", "validate", "--quiet", "--path", validRoot], {
        write: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      }),
      0,
    );
    assertEquals(output, []);
    assertEquals(errors, []);

    assertEquals(
      await main(["template", "validate", "--quiet", "--path", invalidRoot], {
        write: (value) => output.push(value),
        writeError: (value) => errors.push(value),
      }),
      1,
    );
    assertEquals(output, []);
    assertStringIncludes(errors.join("\n"), "Configuration is invalid.");
  } finally {
    await Deno.remove(validRoot, { recursive: true });
    await Deno.remove(invalidRoot, { recursive: true });
  }
});

Deno.test("validate rejects quiet JSON output", async () => {
  const root = await validConfiguration();
  const errors: string[] = [];

  try {
    assertEquals(
      await main(
        ["template", "validate", "--quiet", "--format", "json", "--path", root],
        { writeError: (value) => errors.push(value) },
      ),
      1,
    );
    assertStringIncludes(
      errors.join("\n"),
      "Cannot combine --quiet with --format json",
    );

    errors.length = 0;
    assertEquals(
      await main(
        [
          "template",
          "validate",
          "teams/backend",
          "--quiet",
          "--format",
          "json",
          "--path",
          root,
        ],
        { writeError: (value) => errors.push(value) },
      ),
      1,
    );
    assertStringIncludes(
      errors.join("\n"),
      "Cannot combine --quiet with --format json",
    );
    assertEquals(
      errors.some((value) =>
        value.includes("Template-specific validation is not implemented yet")
      ),
      false,
    );
  } finally {
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

    const result = JSON.parse(output[0]);
    assertEquals(result.valid, true);
    assertEquals(result.diagnostics, []);
    assertEquals(result.issues, []);
    assertEquals(result.intersections.length, 1);
    assertEquals(result.intersections[0].template, "repository:default");
    assertEquals(result.intersections[0].reachable, true);
    assertEquals(result.intersections[0].constraints.include.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate groups repeated runtime references in text output", async () => {
  const root = await repeatedRuntimeReferenceConfiguration();
  const output: string[] = [];

  try {
    assertEquals(
      await main(
        ["template", "validate", "--path", root],
        { write: (value) => output.push(value) },
      ),
      0,
    );
    const text = output[0];
    assertStringIncludes(text, "Configuration is valid.");
    assertEquals((text.match(/Warning: Required /g) ?? []).length, 3);
    assertEquals((text.match(/Required variable "/g) ?? []).length, 1);
    assertEquals((text.match(/SLACK_BOT_OPERATION_TOKEN/g) ?? []).length, 1);
    assertEquals((text.match(/COPILOT_REVIEW_TOKEN/g) ?? []).length, 1);
    assertEquals((text.match(/DEPLOY_ENV/g) ?? []).length, 1);
    assertGroupedReferences(
      warningSection(text, "secret", "SLACK_BOT_OPERATION_TOKEN"),
      "repository.actions.secrets[0]",
    );
    assertGroupedReferences(
      warningSection(text, "secret", "COPILOT_REVIEW_TOKEN"),
      "repository.actions.secrets[1]",
    );
    assertGroupedReferences(
      warningSection(text, "variable", "DEPLOY_ENV"),
      "repository.actions.variables[0]",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate preserves repeated runtime references in json output", async () => {
  const root = await repeatedRuntimeReferenceConfiguration();
  const output: string[] = [];

  try {
    assertEquals(
      await main(
        ["template", "validate", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      0,
    );

    const result = JSON.parse(output[0]);
    assertEquals(result.valid, true);
    assertEquals(
      [...result.diagnostics].sort(byValidationDiagnostic),
      [
        {
          severity: "warning",
          code: "unresolved_variable",
          name: "DEPLOY_ENV",
          template: "repository:infrastructure",
          path: "repository.actions.variables[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "SLACK_BOT_OPERATION_TOKEN",
          template: "repository:infrastructure",
          path: "repository.actions.secrets[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "COPILOT_REVIEW_TOKEN",
          template: "repository:infrastructure",
          path: "repository.actions.secrets[1]",
        },
        {
          severity: "warning",
          code: "unresolved_variable",
          name: "DEPLOY_ENV",
          template: "repository:libraries",
          path: "repository.actions.variables[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "SLACK_BOT_OPERATION_TOKEN",
          template: "repository:libraries",
          path: "repository.actions.secrets[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "COPILOT_REVIEW_TOKEN",
          template: "repository:libraries",
          path: "repository.actions.secrets[1]",
        },
        {
          severity: "warning",
          code: "unresolved_variable",
          name: "DEPLOY_ENV",
          template: "repository:services",
          path: "repository.actions.variables[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "SLACK_BOT_OPERATION_TOKEN",
          template: "repository:services",
          path: "repository.actions.secrets[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "COPILOT_REVIEW_TOKEN",
          template: "repository:services",
          path: "repository.actions.secrets[1]",
        },
        {
          severity: "warning",
          code: "unresolved_variable",
          name: "DEPLOY_ENV",
          template: "repository:toolkit",
          path: "repository.actions.variables[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "SLACK_BOT_OPERATION_TOKEN",
          template: "repository:toolkit",
          path: "repository.actions.secrets[0]",
        },
        {
          severity: "warning",
          code: "unresolved_secret",
          name: "COPILOT_REVIEW_TOKEN",
          template: "repository:toolkit",
          path: "repository.actions.secrets[1]",
        },
      ].sort(byValidationDiagnostic),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate reports all independent semantic issues in one run", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];

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
        "        - api1",
        "        - missing",
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
        '    names: ["api*"]',
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
        '    names: ["api?"]',
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(
      await main(["template", "validate", "--path", root], {
        writeError: (value) => errors.push(value),
      }),
      1,
    );

    const text = errors.join("\n");
    assertStringIncludes(text, "Configuration is invalid.");
    assertStringIncludes(
      text,
      "Repository templates can overlap within configured scope",
    );
    assertStringIncludes(
      text,
      "Repository missing cannot match any template within configured scope",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate emits all semantic issues as json", async () => {
  const root = await Deno.makeTempDir();
  const output: string[] = [];

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
        "        - one",
        "        - two",
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

    assertEquals(
      await main(
        ["template", "validate", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );

    const result = JSON.parse(output[0]);
    assertEquals(result.valid, false);
    assertEquals(result.issues.length, 4);
    assertEquals(
      result.issues.some((issue: { code: string }) =>
        issue.code === "template_unreachable"
      ),
      true,
    );
    assertEquals(result.diagnostics, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate reports independent template loading and semantic issues", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.mkdir(root + "/fragments");
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
    await Deno.writeTextFile(root + "/templates/malformed.yml", "invalid: [\n");
    await Deno.writeTextFile(
      root + "/templates/schema.yml",
      [
        "version: 1",
        "kind: invalid",
        "match:",
        "  include: all",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/include.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include: all",
        "includes:",
        "  - missing-fragment.yml",
        "repository: {}",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/fragments/invalid-combination.yml",
      [
        "version: 1",
        "kind: fragment",
        "resource: repository",
        "repository:",
        "  files:",
        "    managed:",
        "      ensure: exact",
        "      source: managed.txt",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      root + "/templates/effective.yml",
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include: all",
        "includes:",
        "  - ../fragments/invalid-combination.yml",
        "repository:",
        "  files:",
        "    managed:",
        "      ensure: absent",
        "",
      ].join("\n"),
    );
    for (const name of ["one", "two"]) {
      await Deno.writeTextFile(
        root + `/templates/${name}.yml`,
        [
          "version: 1",
          "kind: repository",
          "match:",
          "  include: all",
          "repository: {}",
          "",
        ].join("\n"),
      );
    }

    assertEquals(
      await main(["template", "validate", "--path", root], {
        writeError: (value) => errors.push(value),
      }),
      1,
    );

    const text = errors.join("\n");
    for (
      const template of [
        "repository:malformed",
        "repository:schema",
        "repository:include",
        "repository:effective",
      ]
    ) {
      assertStringIncludes(text, `[${template}]`);
    }
    assertStringIncludes(text, "templates can overlap within configured scope");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate skips coverage for incomplete template sets", async () => {
  const root = await Deno.makeTempDir();
  const errors: string[] = [];

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
        "      names: [api, other]",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(root + "/templates/malformed.yml", "invalid: [\n");
    for (const name of ["one", "two"]) {
      await Deno.writeTextFile(
        root + `/templates/${name}.yml`,
        [
          "version: 1",
          "kind: repository",
          "match:",
          "  include:",
          "    names: [other]",
          "repository: {}",
          "",
        ].join("\n"),
      );
    }

    assertEquals(
      await main(["template", "validate", "--path", root], {
        writeError: (value) => errors.push(value),
      }),
      1,
    );

    const text = errors.join("\n");
    assertStringIncludes(text, "[repository:malformed]");
    assertStringIncludes(text, "templates can overlap within configured scope");
    assertEquals(
      text.includes("Repository api cannot match any template"),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate treats root configuration failures as blockers", async () => {
  const root = await validConfiguration();
  const output: string[] = [];

  try {
    await Deno.writeTextFile(root + "/octosmith.yml", "version: 2\n");
    assertEquals(
      await main(
        ["template", "validate", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    assertEquals(result.valid, false);
    assertEquals(result.issues[0].code, "configuration_load_error");
    assertEquals(result.issues[0].path, "configuration");
    assertStringIncludes(result.issues[0].message, "octosmith.yml");
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

Deno.test("validate accepts all names except a negative name pattern", async () => {
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
        '    names: ["private-*"]',
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(await main(["template", "validate", "--path", root]), 0);
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

Deno.test("validate allows exclusions satisfied by alternate visibility witnesses", async () => {
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
        '    visibility: "public"',
        "repository: {}",
        "",
      ].join("\n"),
    );

    assertEquals(await main(["template", "validate", "--path", root]), 0);
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

Deno.test("validate reports every template unreachable outside configured scope", async () => {
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

    const output: string[] = [];
    assertEquals(
      await main(
        ["template", "validate", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    assertEquals(
      result.issues.filter((issue: { code: string }) =>
        issue.code === "template_unreachable"
      ).length,
      2,
    );
    assertEquals(
      result.issues
        .filter((issue: { code: string }) =>
          issue.code === "template_unreachable"
        )
        .map((issue: { template: string }) => issue.template)
        .sort(),
      ["repository:all-web", "repository:web"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate accepts short and canonical selected template identities", async () => {
  const root = await validConfiguration();

  try {
    for (const template of ["default", "repository:default"]) {
      const output: string[] = [];
      assertEquals(
        await main(
          [
            "template",
            "validate",
            template,
            "--format",
            "json",
            "--path",
            root,
          ],
          { write: (value) => output.push(value) },
        ),
        0,
      );
      const result = JSON.parse(output[0]);
      assertEquals(result.valid, true);
      assertEquals(result.intersections.length, 1);
      assertEquals(result.intersections[0].template, "repository:default");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("selected validation reports root scope coverage issues", async () => {
  const root = await validConfiguration();
  const output: string[] = [];

  try {
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      [
        "version: 1",
        "organization: acme",
        "repositories:",
        "  scope:",
        "    include:",
        "      names: [sample, missing]",
        "",
      ].join("\n"),
    );
    assertEquals(
      await main(
        ["template", "validate", "default", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    assertEquals(result.issues[0].code, "scope_repository_unmatched");
    assertStringIncludes(result.issues[0].message, "missing");
    assertEquals(result.intersections[0].template, "repository:default");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("selected validation uses the complete template set for root coverage", async () => {
  const root = await Deno.makeTempDir();
  const output: string[] = [];

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      "version: 1\norganization: acme\nrepositories:\n  scope:\n    include:\n      names: [sample, second]\n",
    );
    await Deno.writeTextFile(
      root + "/templates/default.yml",
      "version: 1\nkind: repository\nmatch:\n  include:\n    names: [sample]\nrepository: {}\n",
    );
    await Deno.writeTextFile(
      root + "/templates/second.yml",
      "version: 1\nkind: repository\nmatch:\n  include:\n    names: [second]\nrepository: {}\n",
    );

    assertEquals(
      await main(
        ["template", "validate", "default", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      0,
    );
    const result = JSON.parse(output[0]);
    assertEquals(result.valid, true);
    assertEquals(result.intersections.length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("selected validation reports overlaps across the full template set", async () => {
  const root = await Deno.makeTempDir();
  const output: string[] = [];

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      "version: 1\norganization: acme\nrepositories:\n  scope:\n    include: all\n",
    );
    for (const name of ["one", "two"]) {
      await Deno.writeTextFile(
        root + `/templates/${name}.yml`,
        "version: 1\nkind: repository\nmatch:\n  include:\n    names: [team-*]\nrepository: {}\n",
      );
    }

    assertEquals(
      await main(
        ["template", "validate", "one", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    const overlapIssue = result.issues.find((issue: { code: string }) =>
      issue.code === "template_overlap"
    );
    assertEquals(overlapIssue !== undefined, true);
    assertEquals(
      overlapIssue.templates.sort(),
      ["repository:one", "repository:two"],
    );
    assertEquals(result.intersections.length, 1);
    assertEquals(result.intersections[0].template, "repository:one");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate selected template ignores unrelated template load errors", async () => {
  const root = await validConfiguration();

  try {
    await Deno.writeTextFile(root + "/templates/broken.yml", "invalid: [\n");
    assertEquals(
      await main(["template", "validate", "default", "--path", root]),
      0,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate exposes exact include and exclude intersection constraints", async () => {
  const root = await Deno.makeTempDir();
  const output: string[] = [];

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      "version: 1\norganization: acme\nrepositories:\n  scope:\n    include: all\n    exclude:\n      names: [private-*]\n",
    );
    await Deno.writeTextFile(
      root + "/templates/default.yml",
      "version: 1\nkind: repository\nmatch:\n  include: all\n  exclude:\n    names: [archived-*]\nrepository: {}\n",
    );

    assertEquals(
      await main(
        ["template", "validate", "default", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      0,
    );
    const intersection = JSON.parse(output[0]).intersections[0];
    assertEquals(intersection.reachable, true);
    assertEquals(intersection.constraints.include.length, 2);
    assertEquals(intersection.constraints.exclude.length, 2);
    assertEquals(
      intersection.constraints.exclude.map((constraint: { path: string }) =>
        constraint.path
      ),
      [
        "repositories.scope.exclude",
        "templates.repository:default.match.exclude",
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate reports a missing selected template as structured output", async () => {
  const root = await validConfiguration();
  const output: string[] = [];

  try {
    assertEquals(
      await main(
        ["template", "validate", "missing", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    assertEquals(result.valid, false);
    assertEquals(result.issues[0].code, "unknown_template");
    assertEquals(result.issues[0].template, "repository:missing");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validate selected template reports unreachable scope intersection", async () => {
  const root = await Deno.makeTempDir();
  const output: string[] = [];

  try {
    await Deno.mkdir(root + "/templates");
    await Deno.writeTextFile(
      root + "/octosmith.yml",
      "version: 1\norganization: acme\nrepositories:\n  scope:\n    include:\n      visibility: public\n",
    );
    await Deno.writeTextFile(
      root + "/templates/private.yml",
      "version: 1\nkind: repository\nmatch:\n  include:\n    visibility: private\nrepository: {}\n",
    );

    assertEquals(
      await main(
        ["template", "validate", "private", "--format", "json", "--path", root],
        { write: (value) => output.push(value) },
      ),
      1,
    );
    const result = JSON.parse(output[0]);
    const unreachableIssue = result.issues.find((issue: { code: string }) =>
      issue.code === "template_unreachable"
    );
    assertEquals(unreachableIssue !== undefined, true);
    assertEquals(
      unreachableIssue.path,
      "repositories.scope.intersection.repository:private.match",
    );
    assertEquals(result.intersections[0].reachable, false);
    assertEquals(unreachableIssue.constraints.include.length, 2);
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

async function repeatedRuntimeReferenceConfiguration(): Promise<string> {
  const root = await Deno.makeTempDir();
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
      "        - infrastructure",
      "        - libraries",
      "        - services",
      "        - toolkit",
      "",
    ].join("\n"),
  );

  for (const name of ["infrastructure", "libraries", "services", "toolkit"]) {
    await Deno.writeTextFile(
      root + `/templates/${name}.yml`,
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  include:",
        "    names:",
        `      - ${name}`,
        "repository:",
        "  actions:",
        "    variables:",
        "      - DEPLOY_ENV",
        "    secrets:",
        "      - SLACK_BOT_OPERATION_TOKEN",
        "      - COPILOT_REVIEW_TOKEN",
        "",
      ].join("\n"),
    );
  }

  return root;
}

function byValidationDiagnostic(
  left: { template: string; path: string; name: string },
  right: { template: string; path: string; name: string },
): number {
  return `${left.template}\0${left.path}\0${left.name}`.localeCompare(
    `${right.template}\0${right.path}\0${right.name}`,
  );
}

function warningSection(text: string, kind: string, name: string): string {
  const prefix =
    `Warning: Required ${kind} "${name}" requires a runtime value.`;
  const start = text.indexOf(prefix);
  assertEquals(start >= 0, true);
  const next = text.indexOf("\n\nWarning:", start + prefix.length);
  return next >= 0 ? text.slice(start, next) : text.slice(start);
}

function assertGroupedReferences(section: string, path: string): void {
  const referencedBy = section.split("Referenced by:\n")[1];
  assertEquals(referencedBy === undefined, false);
  const names = [
    "repository:infrastructure",
    "repository:libraries",
    "repository:services",
    "repository:toolkit",
  ];
  const width = Math.max(...names.map((name) => name.length));
  assertEquals(
    referencedBy.split("\n").sort(),
    names.map((name) => "  " + name.padEnd(width) + "  " + path).sort(),
  );
}
