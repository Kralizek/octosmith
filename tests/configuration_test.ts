import { assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  buildPlan,
  loadConfigurationDirectory,
  matchesSelector,
  resolveDesiredState,
} from "../packages/core/mod.ts";

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
        "scope:",
        "  properties:",
        "    repository_type: code",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "templates", "code.yml"),
      [
        "match:",
        "  properties:",
        "    repository_type: code",
        "repository:",
        "  custom_properties:",
        "    deployment_region: eu-north-1",
        "files:",
        "  .github/workflows/release_candidate.yml:",
        "    ensure: exact",
        "    source: files/workflow.yml",
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
        "scope:",
        "  names:",
        "    - sample",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
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
        "rulesets:",
        "  - name: protect",
        "    bypass_actors:",
        "      - actor_type: team",
        "        actor_id: 42",
        "        bypass_mode: pull-request",
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

Deno.test("preserves omitted environment members in desired state", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates"));

    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      [
        "version: 1",
        "organization: example-org",
        "scope:",
        "  names:",
        "    - sample",
        "",
      ].join("\n"),
    );

    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
        "match:",
        "  names:",
        "    - sample",
        "environments:",
        "  - name: production",
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
          "scope:",
          "  names:",
          "    - sample",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(root, "templates", "sample.yml"),
        [
          "match:",
          "  names:",
          "    - sample",
          "rulesets:",
          "  - name: policy",
          "    target: " +
          (testCase.rule[0].includes("max_file") ? "push" : "branch"),
          "    enforcement: active",
          ...(testCase.rule[0].includes("max_file") ? [] : [
            "    conditions:",
            "      ref_name:",
            "        include:",
            "          - ~DEFAULT_BRANCH",
          ]),
          "    rules:",
          ...testCase.rule,
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
