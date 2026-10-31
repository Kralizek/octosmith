// Always-attempted cleanup for repositories created by the current E2E run.
import { join } from "@std/path";

const owner = Deno.env.get("E2E_OWNER");
const runId = Deno.env.get("E2E_RUN_ID");
const results = Deno.env.get("E2E_RESULTS");
if (owner !== "octosmith-tests" || !runId || !results ||
  !/^[0-9]+-[0-9]+$/.test(runId)) {
  throw new Error("Refusing cleanup outside a validated dedicated E2E run");
}
const prefix = `octosmith-e2e-${runId}-`;
type Registered = { name: string; fullName: string; id?: number };
const path = join(results, "repositories.json");
const entries: Registered[] = await Deno.readTextFile(path)
  .then((text) => JSON.parse(text))
  .catch(() => []);
const names = new Set(entries.map((entry) => entry.name));
const deleted: string[] = [];
const failed: string[] = [];

async function gh(args: string[]) {
  const output = await new Deno.Command("gh", {
    args, stdout: "piped", stderr: "piped",
    env: { GH_PROMPT_DISABLED: "1" },
  }).output();
  return {
    ok: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// Reconcile the registry with actual remote state. A crash between the
// successful create API call and registry update must not orphan a repo.
const inventory = await gh([
  "api", "--paginate", `orgs/${owner}/repos?per_page=100&type=all`,
  "--jq", ".[] | {name, full_name, id}",
]);
if (!inventory.ok) throw new Error("Cannot enumerate test organization for cleanup");
for (const line of inventory.stdout.split("\n").filter(Boolean)) {
  const repo = JSON.parse(line) as { name: string; full_name: string; id: number };
  if (!repo.name.startsWith(prefix)) continue;
  if (repo.full_name !== `${owner}/${repo.name}` || repo.name === "fixtures") {
    throw new Error("Unsafe repository identity encountered");
  }
  names.add(repo.name);
}
for (const name of [...names].sort()) {
  const fullName = `${owner}/${name}`;
  if (!name.startsWith(prefix) || name === "fixtures") {
    failed.push(`Refused unsafe registry entry: ${fullName}`);
    continue;
  }
  const detail = await gh(["api", `repos/${fullName}`, "--jq", "{id,full_name}"]);
  if (!detail.ok) {
    if (detail.stderr.includes("404")) continue;
    failed.push(`Cannot inspect ${fullName}`);
    continue;
  }
  const actual = JSON.parse(detail.stdout) as { id: number; full_name: string };
  const registered = entries.find((entry) => entry.name === name);
  if (actual.full_name !== fullName ||
    (registered?.id !== undefined && registered.id !== actual.id)) {
    failed.push(`Ownership or ID mismatch: ${fullName}`);
    continue;
  }
  const deletion = await gh(["api", "--method", "DELETE", `repos/${fullName}`]);
  if (!deletion.ok) {
    failed.push(`Deletion failed: ${fullName}`);
  } else {
    deleted.push(fullName);
  }
}
await Deno.mkdir(results, { recursive: true });
await Deno.writeTextFile(
  join(results, "cleanup.json"),
  JSON.stringify({ deleted, failed }, null, 2),
);
const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
if (summary) {
  await Deno.writeTextFile(
    summary,
    `## Octosmith E2E cleanup\n\nDeleted ${deleted.length} run-created repositories.\n\n` +
      (failed.length ? `Failures:\n${failed.map((x) => `- ${x}`).join("\n")}\n` : "No cleanup failures.\n"),
    { append: true },
  );
}
if (failed.length) {
  for (const message of failed) console.error(message);
  Deno.exitCode = 1;
}
