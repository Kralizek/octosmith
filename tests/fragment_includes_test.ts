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
      "    names:",
      "      - sample",
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
      "  names:",
      "    - sample",
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

Deno.test("later arrays replace earlier arrays wholesale", async () => {
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
      "  names:",
      "    - sample",
      "includes:",
      "  - ../fragments/base.yml",
      "  - ../fragments/override.yml",
      "repository: {}",
    ]);

    const loaded = await loadConfigurationDirectory(root);
    assertEquals(loaded.templates["repository:sample"].repository.teams, [
      { name: "developers", permission: "write" },
    ]);
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
      "  names:",
      "    - sample",
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
      "  names:",
      "    - sample",
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
      "  names:",
      "    - sample",
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
          "  names:",
          "    - " + name,
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
      "  names:",
      "    - sample",
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
    const include = relative(join(root, "templates"), outside).replaceAll("\\", "/");
    await writeTemplate(root, [
      "version: 1",
      "kind: repository",
      "match:",
      "  names:",
      "    - sample",
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
      "  names:",
      "    - sample",
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
