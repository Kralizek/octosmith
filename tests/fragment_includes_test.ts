import { assertEquals, assertRejects } from "@std/assert";
import { join, relative } from "@std/path";
import {
  loadConfigurationDirectory,
  validateConfigurationDirectory,
} from "../packages/octosmith/mod.ts";

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

Deno.test("rulesets and environments compose by name, with rules keyed by type", async () => {
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
        rules: [{ type: "deletion" }, { type: "required_signatures" }],
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

Deno.test("later rules of the same type replace parameters atomically", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "rules.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      target: branch",
      "      rules:",
      "        - type: deletion",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 1",
      "            required_review_thread_resolution: true",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "includes:",
      "  - ../fragments/rules.yml",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      rules:",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 2",
      "        - type: required_signatures",
    ]);
    const repository = (await loadConfigurationDirectory(root))
      .templates["repository:sample"].repository;
    assertEquals(repository.rulesets?.[0].rules, [
      { type: "deletion" },
      {
        type: "pull_request",
        parameters: { requiredApprovingReviewCount: 2 },
      },
      { type: "required_signatures" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ruleset rules compose deterministically across two fragments and a template", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      target: branch",
      "      enforcement: active",
      "      rules:",
      "        - type: deletion",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 1",
      "            require_code_owner_review: true",
      "        - type: non_fast_forward",
    ]);
    await writeFragment(root, "more-rules.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      rules:",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 2",
      "        - type: required_signatures",
    ]);
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "includes:",
      "  - ../fragments/base.yml",
      "  - ../fragments/more-rules.yml",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      rules:",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 3",
      "        - type: required_linear_history",
    ]);

    const expected = [
      { type: "deletion" },
      {
        type: "pull_request",
        parameters: { requiredApprovingReviewCount: 3 },
      },
      { type: "non_fast_forward" },
      { type: "required_signatures" },
      { type: "required_linear_history" },
    ] as const;
    const loadRules = async () =>
      (await loadConfigurationDirectory(root))
        .templates["repository:sample"].repository.rulesets?.[0].rules;

    // Overrides retain the first position of a rule type. New types append
    // in the order their fragment/template first introduces them.
    assertEquals(await loadRules(), expected);
    assertEquals(await loadRules(), expected);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit empty rules array clears rules inherited from fragments", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      target: branch",
      "      enforcement: active",
      "      rules:",
      "        - type: deletion",
      "        - type: required_signatures",
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
      "    - name: protect",
      "      rules: []",
    ]);

    const ruleset = (await loadConfigurationDirectory(root))
      .templates["repository:sample"].repository.rulesets?.[0];
    assertEquals(ruleset, {
      name: "protect",
      target: "branch",
      enforcement: "active",
      rules: [],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unregistered ruleset bypass actor arrays replace inherited entries", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      target: branch",
      "      bypass_actors:",
      "        - actor_type: team",
      "          actor_id: 100",
      "          bypass_mode: always",
      "        - actor_type: repository-role",
      "          actor_id: 5",
      "          bypass_mode: pull-request",
      "      rules:",
      "        - type: deletion",
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
      "    - name: protect",
      "      bypass_actors:",
      "        - actor_type: team",
      "          actor_id: 200",
      "          bypass_mode: exempt",
    ]);

    const ruleset = (await loadConfigurationDirectory(root))
      .templates["repository:sample"].repository.rulesets?.[0];
    assertEquals(ruleset?.bypassActors, [
      { actorType: "team", actorId: 200, bypassMode: "exempt" },
    ]);
    assertEquals(ruleset?.rules, [{ type: "deletion" }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ruleset target changes cannot inherit incompatible conditions and rules", async () => {
  for (const target of ["tag", "push"]) {
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
        "      conditions:",
        "        ref_name:",
        "          include: [~DEFAULT_BRANCH]",
        "      rules:",
        "        - type: deletion",
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
        "      target: " + target,
      ]);

      await assertRejects(
        () => loadConfigurationDirectory(root),
        Error,
        'Conflicting targets for ruleset "protect-default-branch"',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("ruleset with implicit original target still gets target-specific planner validation", async () => {
  const root = await createRoot();
  try {
    await writeFragment(root, "base.yml", [
      "version: 1",
      "kind: fragment",
      "resource: repository",
      "repository:",
      "  rulesets:",
      "    - name: example",
      "      conditions:",
      "        ref_name:",
      "          include: [~DEFAULT_BRANCH]",
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
      "    - name: example",
      "      target: push",
      "      enforcement: active",
      "      rules:",
      "        - type: max_file_size",
      "          parameters:",
      "            max_file_size_mb: 1",
    ]);

    await assertRejects(
      () => validateConfigurationDirectory(root),
      Error,
      "Push ruleset example cannot declare ref conditions",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (
  const fixture of [
    {
      name: "teams",
      lines: [
        "  teams:",
        "    - name: platform",
        "      permission: read",
        "    - name: platform",
        "      permission: write",
      ],
      path: "teams",
      identity: "platform",
    },
    {
      name: "rulesets",
      lines: [
        "  rulesets:",
        "    - name: protection",
        "      target: branch",
        "    - name: protection",
        "      target: tag",
      ],
      path: "rulesets",
      identity: "protection",
    },
    {
      name: "environments",
      lines: [
        "  environments:",
        "    - name: staging",
        "    - name: staging",
      ],
      path: "environments",
      identity: "staging",
    },
    {
      name: "Actions secrets",
      lines: [
        "  actions:",
        "    secrets:",
        "      - REVIEW_TOKEN",
        "      - from: DIFFERENT_SOURCE",
        "        to: REVIEW_TOKEN",
      ],
      path: "actions.secrets",
      identity: "REVIEW_TOKEN",
    },
    {
      name: "Actions variables",
      lines: [
        "  actions:",
        "    variables:",
        "      - FEED_URI",
        "      - name: FEED_URI",
        "        value: https://example.org",
      ],
      path: "actions.variables",
      identity: "FEED_URI",
    },
    {
      name: "Dependabot secrets",
      lines: [
        "  dependabot:",
        "    secrets:",
        "      - BOT_TOKEN",
        "      - from: SOURCE",
        "        to: BOT_TOKEN",
      ],
      path: "dependabot.secrets",
      identity: "BOT_TOKEN",
    },
    {
      name: "ruleset rules",
      lines: [
        "  rulesets:",
        "    - name: protect",
        "      rules:",
        "        - type: deletion",
        "        - type: deletion",
      ],
      path: "rulesets.*.rules",
      identity: "deletion",
    },
    {
      name: "environment secrets",
      lines: [
        "  environments:",
        "    - name: staging",
        "      secrets:",
        "        - DEPLOY_TOKEN",
        "        - from: OTHER",
        "          to: DEPLOY_TOKEN",
      ],
      path: "environments.*.secrets",
      identity: "DEPLOY_TOKEN",
    },
    {
      name: "environment variables",
      lines: [
        "  environments:",
        "    - name: staging",
        "      variables:",
        "        - REGION",
        "        - name: REGION",
        "          value: west",
      ],
      path: "environments.*.variables",
      identity: "REGION",
    },
  ]
) {
  Deno.test(
    "rejects duplicate " + fixture.name + " in one fragment",
    async () => {
      const root = await createRoot();
      try {
        await writeFragment(root, "duplicate.yml", [
          "version: 1",
          "kind: fragment",
          "resource: repository",
          "repository:",
          ...fixture.lines,
        ]);
        await writeTemplate(root, [
          "version: 1",
          "kind: repository",
          "match:",
          "  include:",
          "    names: [sample]",
          "includes:",
          "  - ../fragments/duplicate.yml",
          "repository: {}",
        ]);

        await assertRejects(
          () => loadConfigurationDirectory(root),
          Error,
          'Duplicate identity "' + fixture.identity +
            '" in repository.' + fixture.path,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    },
  );
}

Deno.test("rejects duplicate identities in templates without any includes", async () => {
  const root = await createRoot();
  try {
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "repository:",
      "  actions:",
      "    secrets:",
      "      - REVIEW_TOKEN",
      "      - from: OTHER",
      "        to: REVIEW_TOKEN",
    ]);

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      'Duplicate identity "REVIEW_TOKEN" in repository.actions.secrets',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects duplicate rule types in standalone templates without includes", async () => {
  const root = await createRoot();
  try {
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  include:",
      "    names: [sample]",
      "repository:",
      "  rulesets:",
      "    - name: protect",
      "      target: branch",
      "      rules:",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 1",
      "        - type: pull_request",
      "          parameters:",
      "            required_approving_review_count: 2",
    ]);

    const error = await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      'Duplicate identity "pull_request" in repository.rulesets.*.rules',
    );
    assertEquals(error.message.includes("at indexes 0 and 1"), true);
    assertEquals(error.message.includes("templates/sample.yml"), true);
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
      "        source: custom",
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
