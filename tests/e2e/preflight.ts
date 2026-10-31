import { assertEquals } from "@std/assert";
import { E2ERuntime } from "./runtime.ts";

const fixtureRoot = Deno.env.get("E2E_FIXTURES");
const fixtureSha = Deno.env.get("E2E_FIXTURE_REVISION");
if (!fixtureRoot || !fixtureSha) throw new Error("Missing pinned fixtures checkout");
await Deno.stat(fixtureRoot + "/README.md");

const git = await new Deno.Command("git", {
  args: ["-C", fixtureRoot, "rev-parse", "HEAD"],
  stdout: "piped",
}).output();
if (!git.success) throw new Error("Cannot inspect fixtures commit");
assertEquals(new TextDecoder().decode(git.stdout).trim(), fixtureSha);

await E2ERuntime.fromEnvironment().verifyInstallation();
console.log("E2E preflight passed: no repositories created");
