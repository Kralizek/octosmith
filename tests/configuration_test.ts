import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";
import {
  buildPlan,
  loadConfigurationDirectory,
  matchesSelector,
  resolveDesiredState,
  validateConfigurationDirectory,
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
    "repository:code",
    "repository:config",
    "repository:infrastructure",
    "repository:issues",
    "repository:shared-library",
  ]);

  assertEquals(
    loaded.templates["repository:code"].repository?.settings
      ?.deleteBranchOnMerge,
    true,
  );
  assertEquals(
    loaded.templates["repository:code"].repository.rulesets?.[0].conditions
      ?.refName?.include,
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

Deno.test("loads nested templates with kind-scoped path identities", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates", "team-a"), { recursive: true });
    await Deno.mkdir(join(root, "templates", "team-b"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "octosmith.yml"),
      [
        "version: 1",
        "organization: example-org",
        "repositories:",
        "  scope:",
        "    names:",
        "      - '*'",
        "",
      ].join("\n"),
    );

    for (const team of ["team-a", "team-b"]) {
      await Deno.writeTextFile(
        join(root, "templates", team, "backend.yml"),
        [
          "version: 1",
          "kind: repository",
          "name: Backend services",
          "match:",
          "  names:",
          "    - " + team + "-backend",
          "repository: {}",
          "",
        ].join("\n"),
      );
    }

    const loaded = await loadConfigurationDirectory(root);

    assertEquals(Object.keys(loaded.templates).sort(), [
      "repository:team-a/backend",
      "repository:team-b/backend",
    ]);
    assertEquals(
      loaded.templates["repository:team-a/backend"].name,
      "Backend services",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("template version is required", async () => {
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
        "repository: {}",
        "",
      ].join("\n"),
    );

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "version",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("normalizes read and write team permission aliases", async () => {
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
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  teams:",
        "    - name: readers",
        "      permission: read",
        "    - name: writers",
        "      permission: write",
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);
    const desired = await resolveDesiredState(
      loaded,
      { name: "sample", teams: [], properties: {} },
      (name) => name,
    );

    assertEquals(desired.teams, [
      {
        team: "readers",
        permission: { kind: "built-in", name: "pull" },
      },
      {
        team: "writers",
        permission: { kind: "built-in", name: "push" },
      },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("preserves inherited object keys as custom team permissions", async () => {
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
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  teams:",
        "    - name: maintainers",
        "      permission: constructor",
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);
    const desired = await resolveDesiredState(
      loaded,
      { name: "sample", teams: [], properties: {} },
      (name) => name,
    );

    assertEquals(desired.teams, [
      {
        team: "maintainers",
        permission: { kind: "custom", name: "constructor" },
      },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fixture organization agrees with root configuration", async () => {
  const loaded = await loadConfigurationDirectory(CONFIGURATION_ROOT);
  const organization = JSON.parse(
    await Deno.readTextFile(join(FIXTURE_ROOT, "organization.json")),
  );

  assertEquals(organization.organization, loaded.configuration.organization);
});

Deno.test("validation allows literal scope entries without templates when unmatched repositories are ignored", async () => {
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
        "      - unmatched",
        "  settings:",
        "    unmatched_repositories: ignore",
        "",
      ].join("\n"),
    );

    await validateConfigurationDirectory(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects symlinked root configuration file", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempFile();

  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.writeTextFile(
      outside,
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
    await Deno.symlink(outside, join(root, "octosmith.yml"));

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "must be a regular file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside);
  }
});

Deno.test("rejects symlinked templates directory", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();

  try {
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
    await Deno.symlink(outside, join(root, "templates"));

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "Templates path must be a real directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("rejects oversized root configuration file", async () => {
  const root = await Deno.makeTempDir();

  try {
    await Deno.mkdir(join(root, "templates"));
    const configuration = await Deno.open(join(root, "octosmith.yml"), {
      create: true,
      write: true,
      truncate: true,
    });
    try {
      await configuration.truncate(10 * 1024 * 1024 + 1);
    } finally {
      configuration.close();
    }

    await assertRejects(
      () => loadConfigurationDirectory(root),
      Error,
      "exceeds the maximum size",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
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
        "version: 1",
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
    assertEquals(loaded.templates["repository:code"].match.properties, {
      repository_type: "code",
    });
    assertEquals(
      loaded.templates["repository:code"].repository?.customProperties,
      {
        deployment_region: "eu-north-1",
      },
    );
    assertEquals(
      Object.keys(loaded.templates["repository:code"].repository.files ?? {}),
      [
        ".github/workflows/release_candidate.yml",
      ],
    );
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

for (
  const [name, source, message] of [
    [
      "absolute configuration file source",
      "/dev/zero",
      "must be relative to the configuration root",
    ],
    [
      "configuration file source escaping root",
      "../outside.txt",
      "escapes the configuration root",
    ],
  ] as const
) {
  Deno.test(`rejects ${name}`, async () => {
    const root = await Deno.makeTempDir();
    let outsideFile: string | undefined;

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
      let sourceValue: string = source;
      if (source.startsWith("..")) {
        outsideFile = await Deno.makeTempFile({
          dir: join(root, ".."),
          prefix: "octosmith-outside-",
        });
        await Deno.writeTextFile(outsideFile, "outside");
        sourceValue = relative(root, outsideFile);
      }

      await Deno.writeTextFile(
        join(root, "templates", "sample.yml"),
        [
          "version: 1",
          "kind: repository",
          "match:",
          "  names:",
          "    - sample",
          "repository:",
          "  files:",
          "    README.md:",
          "      ensure: exact",
          `      source: ${sourceValue}`,
          "",
        ].join("\n"),
      );

      const loaded = await loadConfigurationDirectory(root);

      await assertRejects(
        () =>
          resolveDesiredState(
            loaded,
            { name: "sample", teams: [], properties: {} },
            (value) => value,
          ),
        Error,
        message,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
      if (outsideFile !== undefined) {
        await Deno.remove(outsideFile);
      }
    }
  });
}

Deno.test("rejects aggregate configuration file sources larger than 50 MiB", async () => {
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
        "    names:",
        "      - sample",
        "",
      ].join("\n"),
    );

    const fileEntries: string[] = [];
    for (let index = 0; index < 6; index++) {
      const source = `files/source-${index}.txt`;
      const file = await Deno.open(join(root, source), {
        create: true,
        write: true,
        truncate: true,
      });
      try {
        await file.truncate(9 * 1024 * 1024);
      } finally {
        file.close();
      }

      fileEntries.push(
        `    file-${index}.txt:`,
        "      ensure: exact",
        `      source: ${source}`,
      );
    }

    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  files:",
        ...fileEntries,
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);

    await assertRejects(
      () =>
        resolveDesiredState(
          loaded,
          { name: "sample", teams: [], properties: {} },
          (value) => value,
        ),
      Error,
      "aggregate limit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects configuration file sources larger than 10 MiB", async () => {
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
        "    names:",
        "      - sample",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      join(root, "templates", "sample.yml"),
      [
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  files:",
        "    README.md:",
        "      ensure: exact",
        "      source: files/large.txt",
        "",
      ].join("\n"),
    );

    const largeFile = await Deno.open(join(root, "files", "large.txt"), {
      create: true,
      write: true,
      truncate: true,
    });
    try {
      await largeFile.truncate(10 * 1024 * 1024 + 1);
    } finally {
      largeFile.close();
    }

    const loaded = await loadConfigurationDirectory(root);

    await assertRejects(
      () =>
        resolveDesiredState(
          loaded,
          { name: "sample", teams: [], properties: {} },
          (value) => value,
        ),
      Error,
      "exceeds the maximum size",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("rejects symlinked configuration file sources escaping root", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempFile();

  try {
    await Deno.mkdir(join(root, "templates"));
    await Deno.mkdir(join(root, "files"));
    await Deno.symlink(outside, join(root, "files", "linked.txt"));
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
        "version: 1",
        "kind: repository",
        "match:",
        "  names:",
        "    - sample",
        "repository:",
        "  files:",
        "    README.md:",
        "      ensure: exact",
        "      source: files/linked.txt",
        "",
      ].join("\n"),
    );

    const loaded = await loadConfigurationDirectory(root);

    await assertRejects(
      () =>
        resolveDesiredState(
          loaded,
          { name: "sample", teams: [], properties: {} },
          (value) => value,
        ),
      Error,
      "escapes the configuration root",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside);
  }
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
        "version: 1",
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
        "version: 1",
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
        "version: 1",
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
          "version: 1",
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
