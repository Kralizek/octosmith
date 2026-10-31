// Opt-in GitHub E2E acceptance tests. Never include this in deno task check.
import { join } from "@std/path";

const owner = Deno.env.get("E2E_OWNER");
const runId = Deno.env.get("E2E_RUN_ID");
const results = Deno.env.get("E2E_RESULTS");
const fixtures = Deno.env.get("E2E_FIXTURES");
if (owner !== "octosmith-tests" || !runId || !results || !fixtures) {
  throw new Error("E2E requires the dedicated octosmith-tests owner and run context");
}
if (!/^[0-9]+-[0-9]+$/.test(runId)) {
  throw new Error("Expected GitHub Actions run ID and attempt");
}

const prefix = `octosmith-e2e-${runId}-`;
const registryPath = join(results, "repositories.json");
const outcomePath = join(results, "outcomes.json");
const workspace = join(results, "workspace");
await Deno.mkdir(workspace, { recursive: true });

type Registered = { name: string; fullName: string; id?: number };
type Outcome = { scenario: string; status: "passed" | "failed"; details: string };
const registered: Registered[] = [];
const outcomes: Outcome[] = [];

async function execute(command: string, args: string[], cwd?: string) {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    env: { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return { ok: result.success, stdout, stderr, code: result.code };
}

async function ghJson(path: string): Promise<Record<string, unknown>> {
  const r = await execute("gh", ["api", path]);
  if (!r.ok) throw new Error(`GitHub API ${path} failed: exit ${r.code}`);
  return JSON.parse(r.stdout);
}

async function saveRegistry() {
  await Deno.writeTextFile(registryPath, JSON.stringify(registered, null, 2));
}

async function saveOutcomes() {
  await Deno.writeTextFile(outcomePath, JSON.stringify(outcomes, null, 2));
}

async function inspect(name: string, expectedPaths: string[]) {
  const repo = await ghJson(`repos/${owner}/${name}`);
  if (repo.full_name !== `${owner}/${name}` || repo.private !== true) {
    throw new Error("Unexpected repository owner or visibility");
  }
  const defaultBranch = repo.default_branch as string;
  const branch = await ghJson(
    `repos/${owner}/${name}/branches/${encodeURIComponent(defaultBranch)}`,
  );
  const commit = await ghJson(
    `repos/${owner}/${name}/git/commits/${(branch.commit as Record<string, string>).sha}`,
  );
  if ((commit.parents as unknown[]).length !== 0) {
    throw new Error("Bootstrap commit is not a single root commit");
  }
  const tree = await ghJson(
    `repos/${owner}/${name}/git/trees/${(commit.tree as Record<string, string>).sha}?recursive=1`,
  );
  const paths = (tree.tree as { path: string; type: string }[])
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...expectedPaths].sort())) {
    throw new Error(`Unexpected Git tree: ${JSON.stringify(paths)}`);
  }
  return { repoId: repo.id, sha: (branch.commit as Record<string, string>).sha, paths };
}

async function createScenario(
  scenario: string,
  files: Record<string, string>,
  absent: string[] = [],
  commands: string[] = [],
) {
  const name = `${prefix}${scenario}`;
  const fullName = `${owner}/${name}`;
  // Register expected ownership *before* any mutation so partial creation is
  // eligible for cleanup even if the Octosmith process fails immediately after.
  registered.push({ name, fullName });
  await saveRegistry();
  const existing = await execute("gh", ["api", `repos/${fullName}`]);
  if (existing.ok) throw new Error(`Refusing to adopt existing repository ${fullName}`);
  if (!existing.stderr.includes("404")) {
    throw new Error(`Cannot establish that ${fullName} is unused`);
  }

  const config = join(workspace, scenario);
  await Deno.mkdir(join(config, "templates"), { recursive: true });
  await Deno.mkdir(join(config, "files"), { recursive: true });
  await Deno.writeTextFile(
    join(config, "octosmith.yml"),
    `version: 1\norganization: ${owner}\nrepositories:\n  scope:\n    include:\n      names: ["${name}"]\n      visibility: private\n`,
  );
  const declarations: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    const sourcePath = `files/${path}`;
    await Deno.mkdir(join(config, "files", ...path.split("/").slice(0, -1)), {
      recursive: true,
    });
    await Deno.writeTextFile(join(config, sourcePath), source);
    declarations.push(`    ${JSON.stringify(path)}:\n      ensure: exact\n      source: ${JSON.stringify(sourcePath)}`);
  }
  for (const path of absent) {
    declarations.push(`    ${JSON.stringify(path)}:\n      ensure: absent`);
  }
  const yaml = [
    "version: 1",
    "kind: repository",
    "name: E2E",
    "match:",
    "  include:",
    `    names: ["${name}"]`,
    "repository:",
    "  settings:",
    "    visibility: private",
    "    default_branch: main",
    "    has_issues: false",
    ...(commands.length
      ? ["  post_create_commands:", ...commands.map((cmd) =>
        `    - command: sh\n      args: ["-c", ${JSON.stringify(cmd)}]`
      )]
      : []),
    ...(declarations.length ? ["  files:", ...declarations] : []),
    "",
  ].join("\n");
  await Deno.writeTextFile(join(config, "templates", "scenario.yml"), yaml);

  const create = await execute("deno", [
    "run", "-A", "packages/cli/mod.ts", "resource", "create", "scenario",
    "--path", config, "--name", name, "--visibility", "private", "--format", "json",
  ]);
  await Deno.writeTextFile(
    join(results, `${scenario}-create.json`),
    create.stdout || JSON.stringify({ exit: create.code, stderr: create.stderr }),
  );
  if (!create.ok) throw new Error(`Octosmith resource create failed (${create.code})`);

  const expectedPaths = [...Object.keys(files), ...(commands.length ? ["generator-output.txt"] : [])];
  const observed = await inspect(name, expectedPaths);
  for (const [filePath, expectedContent] of Object.entries(files)) {
    const remote = await ghJson(`repos/${owner}/${name}/contents/${filePath}`);
    if (typeof remote.content !== "string" || remote.encoding !== "base64") {
      throw new Error(`Cannot independently read ${filePath}`);
    }
    const actual = Uint8Array.from(atob(remote.content.replace(/\\s/g, "")), (char) => char.charCodeAt(0));
    const expected = new TextEncoder().encode(expectedContent);
    if (actual.length !== expected.length || !actual.every((byte, index) => byte === expected[index])) {
      throw new Error(`Managed content differs remotely: ${filePath}`);
    }
  }
  registered[registered.length - 1].id = observed.repoId as number;
  await saveRegistry();
  const plan = await execute("deno", [
    "run", "-A", "packages/cli/mod.ts", "plan", "--path", config, "--format", "json",
  ]);
  if (!plan.ok) throw new Error(`Follow-up plan failed (${plan.code})`);
  const result = JSON.parse(plan.stdout) as Record<string, unknown>;
  await Deno.writeTextFile(join(results, `${scenario}-plan.json`), plan.stdout);
  // A successful plan is necessary, but not sufficient proof of zero drift.
  // Also retain its full JSON so reviewers can examine any reported operations.
  await Deno.writeTextFile(
    join(results, `${scenario}-remote.json`),
    JSON.stringify(observed, null, 2),
  );
  if (!result || typeof result !== "object") throw new Error("Invalid plan JSON");
}

try {
  const fixtureContent = await Deno.readTextFile(join(fixtures, "README.md"));
  const scenarios = [
    {
      name: "declarative",
      files: {
        "README.md": fixtureContent,
        "docs/unicode.txt": "Napoli, Stockholm, Göteborg — 東京\n",
        "no-final-newline.txt": "no trailing newline",
        "nested/config.json": '{"version":1}\n',
      },
      absent: [],
      commands: [],
    },
    { name: "empty", files: {}, absent: [], commands: [] },
    {
      name: "generated",
      files: { "README.md": "Managed source wins\n" },
      absent: [],
      commands: [
        "printf 'generated\\n' > generator-output.txt",
      ],
    },
  ];
  for (const scenario of scenarios) {
    try {
      await createScenario(
        scenario.name,
        scenario.files,
        scenario.absent,
        scenario.commands,
      );
      outcomes.push({ scenario: scenario.name, status: "passed", details: "Created and independently inspected" });
    } catch (error) {
      outcomes.push({ scenario: scenario.name, status: "failed", details: String(error) });
    }
    await saveOutcomes();
  }
} finally {
  await saveRegistry();
  await saveOutcomes();
}
if (outcomes.some((outcome) => outcome.status === "failed")) Deno.exitCode = 1;
