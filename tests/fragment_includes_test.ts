import { assertEquals, assertRejects } from "@std/assert";
import { join, relative } from "@std/path";
import { loadConfigurationDirectory } from "../packages/octosmith/mod.ts";

async function createRoot(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "templates"), { recursive: true });
  await Deno.mkdir(join(root, "fragments"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "octosmith.yml"),
    [
      "version: 1",
      "organization: example-org",
      "repositories:",
      "  scope:",
      "    include:",
      "      names:",
      "        - sample",
      "",
    ].join("\n"),
  );
  return root;
}

async function writeTemplate(
  root: string,
  lines: readonly string[],
): Promise<void> {
  await Deno.writeTextFile(
    join(root, "templates", "sample.yml"),
    [...lines, ""].join("\n"),
  );
}

async function writeFragment(
  root: string,
  path: string,
  lines: readonly string[],
): Promise<void> {
  const fullPath = join(root, "fragments", path);
  await Deno.mkdir(join(fullPath, ".."), { recursive: true });
  await Deno.writeTextFile(fullPath, [...lines, ""].join("\n"));
}

Deno.test("composes nested fragments relative to the declaring fragment", async () => {
  const root = await createRoot();
  try {
    await Deno.mkdir(join(root, "fragments", "dotnet"), { recursive: true });
    await writeFragment(root, "common.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  settings:",
      "    has_wiki: false",
      "    has_issues: false",
      "  custom_properties:",
      "    runtime: common",
    ]);
    await writeFragment(root, "dotnet/service.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ../common.yml",
      "repository:",
      "  settings:",
      "    has_issues: true",
      "  custom_properties:",
      "    framework: dotnet",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/dotnet/service.yml",
      "repository:",
      "  settings:",
      "    has_projects: true",
    ]);

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(loaded.templates["repository:sample"].repository.settings, {
      hasWiki: false,
      hasIssues: true,
      hasProjects: true,
    });
    assertEquals(
      loaded.templates["repository:sample"].repository.customProperties,
      { runtime: "common", framework: "dotnet" },
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("named collections preserve unrelated entries from fragments", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  teams:",
      "    - name: platform",
      "      permission: read",
    ]);
    await writeFragment(root, "override.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  teams:",
      "    - name: developers",
      "      permission: write",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/base.yml",
      "  - ../fragments/override.yml",
      "repository: {}",
    ]);

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(loaded.templates["repository:sample"].repository.teams, [
      { name: "platform", permission: "read" },
      { name: "developers", permission: "write" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("later team entries override the same identity in place", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  teams:",
      "    - name: platform",
      "      permission: read",
      "    - name: developers",
      "      permission: read",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "includes:",
      "  - ../fragments/base.yml",
      "repository:",
      "  teams:",
      "    - name: developers",
      "      permission: write",
      "    - name: maintainers",
      "      permission: maintain",
    ]);

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(loaded.templates["repository:sample"].repository.teams, [
      { name: "platform", permission: "read" },
      { name: "developers", permission: "write" },
      { name: "maintainers", permission: "maintain" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Actions and Dependabot values merge by destination, not source", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  actions:",
      "    secrets:",
      "      - COPILOT_REVIEW_TOKEN",
      "      - from: OLD_SECRET",
      "        to: FEED_SECRET",
      "    variables:",
      "      - from: OLD_SOURCE",
      "        to: FEED_URI",
      "      - name: KEEP",
      "        value: baseline",
      "  dependabot:",
      "    secrets:",
      "      - from: OLD_DEPENDABOT",
      "        to: BOT_TOKEN",
    ]);
    await writeFragment(root, "more.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  actions:",
      "    secrets:",
      "      - from: NEW_SECRET",
      "        to: FEED_SECRET",
      "      - EXTRA_SECRET",
      "    variables:",
      "      - name: FEED_URI",
      "        value: https://example.org/feed",
      "      - NEW_VARIABLE",
      "  dependabot:",
      "    secrets:",
      "      - from: NEW_DEPENDABOT",
      "        to: BOT_TOKEN",
      "      - EXTRA_BOT_TOKEN",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "includes:",
      "  - ../fragments/base.yml",
      "  - ../fragments/more.yml",
      "repository: {}",
    ]);

    const repository = (await loadConfigurationDirectory(root))
      .templates["repository:sample"].repository;
    assertEquals(repository.actions?.secrets, [
      "COPILOT_REVIEW_TOKEN",
      { from: "NEW_SECRET", to: "FEED_SECRET" },
      "EXTRA_SECRET",
    ]);
    assertEquals(repository.actions?.variables, [
      { name: "FEED_URI", value: "https://example.org/feed" },
      { name: "KEEP", value: "baseline" },
      "NEW_VARIABLE",
    ]);
    assertEquals(repository.dependabot?.secrets, [
      { from: "NEW_DEPENDABOT", to: "BOT_TOKEN" },
      "EXTRA_BOT_TOKEN",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rulesets and environments compose by name without merging rule arrays", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: protect-default-branch",
      "      target: branch",
      "      enforcement: active",
      "      rules:",
      "        - type: deletion",
      "    - name: other",
      "      target: branch",
      "      rules:",
      "        - type: non_fast_forward",
      "  environments:",
      "    - name: staging",
      "      secrets:",
      "        - ORIGINAL_SECRET",
      "        - from: OLD_TOKEN",
      "          to: DEPLOY_TOKEN",
      "      variables:",
      "        - name: REGION",
      "          value: east",
      "    - name: production",
      "      secrets:",
      "        - PROD_ONLY",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "includes:",
      "  - ../fragments/base.yml",
      "repository:",
      "  rulesets:",
      "    - name: protect-default-branch",
      "      rules:",
      "        - type: required_signatures",
      "    - name: extra",
      "      target: branch",
      "      rules:",
      "        - type: deletion",
      "  environments:",
      "    - name: staging",
      "      secrets:",
      "        - from: NEW_TOKEN",
      "          to: DEPLOY_TOKEN",
      "        - ADDITIONAL_SECRET",
      "      variables:",
      "        - name: REGION",
      "          value: west",
      "        - REGION_2",
    ]);

    const repository = (await loadConfigurationDirectory(root))
      .templates["repository:sample"].repository;
    assertEquals(repository.rulesets, [
      {
        name: "protect-default-branch",
        target: "branch",
        enforcement: "active",
        rules: [{ type: "required_signatures" }],
      },
      {
        name: "other",
        target: "branch",
        rules: [{ type: "non_fast_forward" }],
      },
      {
        name: "extra",
        target: "branch",
        rules: [{ type: "deletion" }],
      },
    ]);
    assertEquals(repository.environments, [
      {
        name: "staging",
        secrets: [
          "ORIGINAL_SECRET",
          { from: "NEW_TOKEN", to: "DEPLOY_TOKEN" },
          "ADDITIONAL_SECRET",
        ],
        variables: [
          { name: "REGION", value: "west" },
          "REGION_2",
        ],
      },
      { name: "production", secrets: ["PROD_ONLY"] },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unkeyed arrays replace and empty keyed arrays reset inherited entries", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  teams:",
      "    - name: platform",
      "      permission: read",
      "  actions:",
      "    secrets:",
      "      - COPILOT_REVIEW_TOKEN",
      "    oidc:",
      "      subject_claim_template:",
      "        source: custom",
      "        claims: [repo, context]",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "includes:",
      "  - ../fragments/base.yml",
      "repository:",
      "  teams: []",
      "  actions:",
      "    secrets: []",
      "    oidc:",
      "      subject_claim_template:",
      "        claims: [repo]",
    ]);

    const repository = (await loadConfigurationDirectory(root))
      .templates["repository:sample"].repository;
    assertEquals(repository.teams, []);
    assertEquals(repository.actions?.secrets, []);
    assertEquals(repository.actions?.oidc?.subjectClaimTemplate, {
      source: "custom",
      claims: ["repo"],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("aggregation-only fragments are valid", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "settings.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  settings:",
      "    has_wiki: false",
    ]);
    await writeFragment(root, "bundle.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ./settings.yml",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/bundle.yml",
      "repository: {}",
    ]);

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(
      loaded.templates["repository:sample"].repository.settings?.hasWiki,
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects empty fragments", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "empty.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/empty.yml",
      "repository: {}",
    ]);

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "Invalid configuration",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applies a diamond-included fragment only once per template", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "common.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  settings:",
      "    description: common",
    ]);
    await writeFragment(root, "left.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ./common.yml",
      "repository:",
      "  settings:",
      "    description: left",
    ]);
    await writeFragment(root, "right.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ./common.yml",
      "repository:",
      "  settings:",
      "    has_wiki: false",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/left.yml",
      "  - ../fragments/right.yml",
      "repository: {}",
    ]);

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(loaded.templates["repository:sample"].repository.settings, {
      description: "left",
      hasWiki: false,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fragment de-duplication is scoped per root template", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "common.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  settings:",
      "    has_wiki: false",
    ]);
    for (const name of ["a", "b"]) {
      await Deno.writeTextFile(
        join(root, "templates", name + ".yml"),
        [
          "version: 1",
          "kind: repository",
          "match:",
          "  include:",
          "    names:",
          "      - " + name,
          "includes:",
          "  - ../fragments/common.yml",
          "repository: {}",
          "",
        ].join("\n"),
      );
    }

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(
      loaded.templates["repository:a"].repository.settings?.hasWiki,
      false,
    );
    assertEquals(
      loaded.templates["repository:b"].repository.settings?.hasWiki,
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("detects cycles across multiple fragment hops", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "a.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ./b.yml",
    ]);
    await writeFragment(root, "b.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ./c.yml",
    ]);
    await writeFragment(root, "c.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "includes:",
      "  - ./a.yml",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/a.yml",
      "repository: {}",
    ]);

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "Cyclic fragment include detected",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects includes that escape the configuration root", async () => {
  const root = await createRoot();
  const outside = await Deno.makeTempFile({
    dir: join(root, ".."),
    prefix: "octosmith-fragment-",
    suffix: ".yml",
  });
  try {
    await Deno.writeTextFile(
      outside,
      [
        "version: 1",
        "kind: fragment",
        "resource: repository",
        "repository: {}",
        "",
      ].join("\n"),
    );
    const include = relative(join(root, "templates"), outside).replaceAll(
      "\\",
      "/",
    );
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - " + include,
      "repository: {}",
    ]);

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "escapes the configuration root",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside);
  }
});

Deno.test("rejects fragment include chains deeper than 32 levels", async () => {
  const root = await createRoot();
  try {
    for (let index = 0; index < 33; index++) {
      const lines = [
        "version: 1",
        "kind: fragment",
        "resource: repository",
      ];
      if (index < 32) {
        lines.push("includes:", "  - ./fragment-" + (index + 1) + ".yml");
      } else {
        lines.push("repository: {}");
      }
      await writeFragment(root, "fragment-" + index + ".yml", lines);
    }
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/fragment-0.yml",
      "repository: {}",
    ]);

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "Maximum fragment include depth of 32 exceeded",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects invalid effective configurations produced by merging variants", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "exact.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  files:",
      "    README.md:",
      "      ensure: exact",
      "      source: files/README.md",
    ]);
    await writeFragment(root, "absent.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  files:",
      "    README.md:",
      "      ensure: absent",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names:",
      "      - sample",
      "includes:",
      "  - ../fragments/exact.yml",
      "  - ../fragments/absent.yml",
      "repository: {}",
    ]);

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "Invalid effective repository configuration",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
