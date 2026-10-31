import { E2ERuntime, type Scenario } from "./runtime.ts";

// The fixtures checkout is an independent, pinned source repository.
// Only this file is discovered by the opt-in live E2E test command.
const generate: Scenario["commands"] = [{
  command: "deno",
  args: [
    "eval",
    "Deno.writeTextFileSync('generator-output.txt', 'generated\\n')",
  ],
}];

const scenarios: readonly Scenario[] = [
  {
    name: "declarative",
    files: [
      { target: "README.md", fixture: "README.md" },
      { target: "docs/unicode.txt", content: "Napoli, Göteborg — 東京\n" },
      { target: "no-final-newline.txt", content: "no trailing newline" },
      { target: "nested/config.json", content: '{"version":1}\n' },
    ],
  },
  { name: "empty" },
  {
    name: "generated",
    files: [{ target: "README.md", content: "Managed source wins\n" }],
    commands: generate,
  },
  {
    name: "collision",
    files: [{ target: "README.md", fixture: "README.md" }],
    commands: [{
      command: "deno",
      args: [
        "eval",
        "Deno.writeTextFileSync('README.md', 'generator wins?\\n'); Deno.writeTextFileSync('generator-output.txt', 'generated\\n')",
      ],
    }],
  },
  {
    name: "fragments",
    fragment: true,
    files: [
      { target: "README.md", fixture: "README.md" },
      {
        target: "docs/architecture.md",
        content: "Composed from a fragment.\n",
      },
    ],
  },
  {
    name: "absence",
    files: [{ target: "README.md", fixture: "README.md" }],
    absent: ["obsolete.txt"],
  },
  {
    name: "recovery",
    commands: [{ command: "deno", args: ["eval", "Deno.exit(17)"] }],
    expectFailure: "after-create",
  },
  {
    name: "unsafe-path",
    files: [{ target: "../outside.txt", content: "should never be committed" }],
    expectFailure: "before-create",
  },
  {
    name: "assisted",
    assisted: true,
    files: [{ target: "README.md", fixture: "README.md" }],
  },
  {
    name: "workflow",
    files: [{
      target: ".github/workflows/ci.yml",
      content:
        "name: Fixture\non:\n  workflow_dispatch:\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fixture\n",
    }],
  },
];

for (const scenario of scenarios) {
  Deno.test("creation: " + scenario.name, async () => {
    const runtime = E2ERuntime.fromEnvironment();
    await runtime.runCreation(scenario);
  });
}
