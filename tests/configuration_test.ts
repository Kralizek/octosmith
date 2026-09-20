import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  buildPlan,
  loadConfigurationDirectory,
  matchesSelector,
  resolveDesiredState,
} from "../packages/octosmith/mod.ts";

import { currentState } from "./plan/fixtures.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const CONFIGURATION_ROOT = join(ROOT, "examples", "configuration");
const FIXTURE_ROOT = join(ROOT, "tests", "fixtures", "configuration");

Deno.test("loads example configuration and templates", async () => {
  const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);

  assertEquals(loaded.configuration, {
    version: 1,
    organization: "example-org",
    repositories: {
      scope: {
        teams: ["platform-team"],
      },
    },
  });

  assertEquals(Object.keys(loaded.templates).sort(), [
    "code",
    "config",
    "infrastructure",
    "issues",
    "shared-library",
  ]);

  assertEquals(
    loaded.templates.code.repository?.settings?.deleteBranchOnMerge,
    true,
  );
  assertEquals(
    loaded.templates.code.repository.rulesets?.[0].conditions?.refName?.include,
    ["~DEFAULT_BRANCH"],
  );
});

for (
  const repository of [
    "api-service",
    "terraform-networking",
    "shared-library",
    "issue-tracker",
    "config-repository",
  ]
) {
  Deno.test(
    "resolves " + repository + " to its golden DesiredState",
    async () => {
      const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);
      const metadata = JSON.parse(
        await Deno.readTextFile(
          join(FIXTURE_ROOT, "repositories", repository + ".json"),
        ),
      );
      const expected = JSON.parse(
        await Deno.readTextFile(
          join(FIXTURE_ROOT, "expected", repository + ".json"),
        ),
      );

      const desired = await resolveDesiredState(
        loaded,
        metadata,
        (name) => name + "-value",
      );

      assertEquals(desired, expected);
    },
  );
}

Deno.test("fixture organization agrees with root configuration", async () => {
  const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);
  const organization = JSON.parse(
    await Deno.readTextFile(join(FIXTURE_ROOT, "organization.json")),
  );

  assertEquals(organization.organization, loaded.configuration.organization);
});

Deno.test("preserves arbitrary configuration map keys", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.mkdir(join(root, "files"));

    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      [
        "version: 1",
        "organization: example-org",
        "repositories:",
        "  scope:",
        "    properties:",
        "      repository_type: code",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "templates", "code.yml"),
      [
        "kind: repository",
        "match:",
        "  properties:",
        "    repository_type: code",
        "repository:",
        "  custom_properties:",
        "    deployment_region: eu-north-1",
        "  files:",
        "    .github/workflows/release_candidate.yml:",
        "      ensure: exact",
        "      source: files/workflow.yml",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "files", "workflow.yml"),
      "name: release\n",
    );

    const loaded = await loadConfigurationDirectory(root);

    assertEquals(loaded.configuration.repositories.scope.properties, {
      repository_type: "code",
    });
    assertEquals(loaded.templates.code.match.properties, {
      repository_type: "code",
    });
    assertEquals(loaded.templates.code.repository?.customProperties, {
      deployment_region: "eu-north-1",
    });
    assertEquals(Object.keys(loaded.templates.code.repository.files ?? {}), [
      ".github/workflows/release_candidate.yml",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("name selectors treat regex metacharacters literally", () => {
  assertEquals(
    matchesSelector(
      { names: ["lib+(core)*"] },
      {
        name: "lib+(core)-api",
        teams: [],
        properties: {},
      },
    ),
    true,
  );

  assertEquals(
    matchesSelector(
      { names: ["lib[core]"] },
      {
        name: "libc",
        teams: [],
        properties: {},
      },
    ),
    false,
  );
});

Deno.test("resolves Actions settings and ruleset bypass actors", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates"));

    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      [
        "version: 1",
        "organization: example-org",
        "repositories:",
        "  scope:",
        "    names:",
        "      - sample",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  actions:",
        "    enabled: true",
        "    allowed_actions: local_only",
        "    sha_pinning_required: true",
        "    oidc:",
        "      subject_claim_template:",
        "        source: custom",
        "        claims:",
        "          - repo",
        "      immutable_subject: true",
        "  rulesets:",
        "    - name: protect",
        "      bypass_actors:",
        "        - actor_type: team",
        "          actor_id: 42",
        "          bypass_mode: pull-request",
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);
    const desired = await resolveDesiredState(
      loaded,
      {
        name: "sample",
        teams: [],
        properties: {},
      },
      (name) => name,
    );

    assertEquals(desired.actions, {
      enabled: true,
      allowedActions: "local-only",
      shaPinningRequired: true,
      oidc: {
        subjectClaimTemplate: {
          source: "custom",
          claims: ["repo"],
        },
        immutableSubject: true,
      },
    });
    assertEquals(desired.rulesets?.[0].bypassActors, [{
      actorType: "team",
      actorId: 42,
      bypassMode: "pull-request",
    }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolves variable and secret binding forms", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      [
        "version: 1",
        "organization: example-org",
        "repositories:",
        "  scope:",
        "    names:",
        "      - sample",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  actions:",
        "    variables:",
        "      - SIMPLE_VARIABLE",
        "      - from: EXTERNAL_VARIABLE",
        "        to: IMPORTED_VARIABLE",
        "      - name: STATIC_VARIABLE",
        "        value: literal-value",
        "    secrets:",
        "      - SIMPLE_SECRET",
        "      - from: EXTERNAL_SECRET",
        "        to: IMPORTED_SECRET",
        "  dependabot:",
        "    secrets:",
        "      - from: EXTERNAL_DEPENDABOT_SECRET",
        "        to: IMPORTED_DEPENDABOT_SECRET",
        "  environments:",
        "    - name: production",
        "      variables:",
        "        - from: EXTERNAL_ENV_VARIABLE",
        "          to: IMPORTED_ENV_VARIABLE",
        "        - name: STATIC_ENV_VARIABLE",
        "          value: environment-literal",
        "      secrets:",
        "        - from: EXTERNAL_ENV_SECRET",
        "          to: IMPORTED_ENV_SECRET",
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);
    const desired = await resolveDesiredState(
      loaded,
      { name: "sample", teams: [], properties: {} },
      (name) => "runtime:" + name,
    );

    assertEquals(desired.actions?.variables, [
      { name: "SIMPLE_VARIABLE", value: "runtime:SIMPLE_VARIABLE" },
      { name: "IMPORTED_VARIABLE", value: "runtime:EXTERNAL_VARIABLE" },
      { name: "STATIC_VARIABLE", value: "literal-value" },
    ]);
    assertEquals(desired.actions?.secrets, [
      { name: "SIMPLE_SECRET", source: "SIMPLE_SECRET" },
      { name: "IMPORTED_SECRET", source: "EXTERNAL_SECRET" },
    ]);
    assertEquals(desired.dependabot?.secrets, [{
      name: "IMPORTED_DEPENDABOT_SECRET",
      source: "EXTERNAL_DEPENDABOT_SECRET",
    }]);
    assertEquals(desired.environments, [{
      name: "production",
      variables: [
        {
          name: "IMPORTED_ENV_VARIABLE",
          value: "runtime:EXTERNAL_ENV_VARIABLE",
        },
        { name: "STATIC_ENV_VARIABLE", value: "environment-literal" },
      ],
      secrets: [{
        name: "IMPORTED_ENV_SECRET",
        source: "EXTERNAL_ENV_SECRET",
      }],
    }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preserves omitted environment members in desired state", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates"));

    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      [
        "version: 1",
        "organization: example-org",
        "repositories:",
        "  scope:",
        "    names:",
        "      - sample",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  environments:",
        "    - name: production",
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);
    const desired = await resolveDesiredState(
      loaded,
      {
        name: "sample",
        teams: [],
        properties: {},
      },
      (name) => name,
    );

    assertEquals(desired.environments, [{ name: "production" }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (
  const testCase of [
    {
      name: "YAML rules reject null required scalar before planning",
      rule: [
        "      - type: max_file_size",
        "        parameters:",
        "          max_file_size_mb: null",
      ],
      message: "requires maxFileSizeMb",
    },
    {
      name: "YAML rules reject null nested required field before planning",
      rule: [
        "      - type: required_status_checks",
        "        parameters:",
        "          do_not_enforce_on_create: false",
        "          checks:",
        "            - context: null",
        "          strict: true",
      ],
      message: "required status check at index 0 requires context",
    },
    {
      name: "YAML rules reject non-object nested entries before planning",
      rule: [
        "      - type: required_status_checks",
        "        parameters:",
        "          do_not_enforce_on_create: false",
        "          checks:",
        "            - bad",
        "          strict: true",
      ],
      message: "required status check at index 0 must be an object",
    },
  ] as const
) {
  Deno.test(testCase.name, async () => {
    const root = await Deno.makeTempDir();

    try {
      await Deno.mkdir(join(root, "templates"));
      await Deno.writeTextFile(
        join(root, "octosmith.yml"),
        [
          "version: 1",
          "organization: example-org",
          "repositories:",
          "  scope:",
          "    names:",
          "      - sample",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(root, "templates", "sample.yml"),
        [
          "kind: repository",
          "match:",
          "  names:",
          "    - sample",
          "repository:",
          "  rulesets:",
          "    - name: policy",
          "      target: " +
          (testCase.rule[0].includes("max_file") ? "push" : "branch"),
          "      enforcement: active",
          ...(testCase.rule[0].includes("max_file") ? [] : [
            "      conditions:",
            "        ref_name:",
            "          include:",
            "            - ~DEFAULT_BRANCH",
          ]),
          "      rules:",
          ...testCase.rule.map((line) => "      " + line),
          "",
        ].join("\n"),
      );

      const loaded = await loadConfigurationDirectory(root);
      const desired = await resolveDesiredState(
        loaded,
        { name: "sample", teams: [], properties: {} },
        (name) => name,
      );

      assertThrows(
        () => buildPlan(currentState(), desired),
        Error,
        testCase.message,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
