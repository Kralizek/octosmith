import { assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml";
import { buildCliArguments, readActionInputs } from "../action/mod.ts";

Deno.test("action metadata runs the checked-out OctoSmith source", async () => {
  const action = parse(await Deno.readTextFile("action.yml")) as Record<
    string,
    unknown
  >;
  const runs = action.runs as Record<string, unknown>;
  const steps = runs.steps as readonly Record<string, unknown>[];

  assertEquals(runs.using, "composite");
  assertEquals(
    steps.some((step) => step.uses === "denoland/setup-deno@v2"),
    true,
  );
  assertEquals(
    steps.some((step) =>
      typeof step.run === "string" &&
      step.run.includes("$GITHUB_ACTION_PATH/action/mod.ts")
    ),
    true,
  );
});

Deno.test("action inputs map to CLI grammar", () => {
  const values: Record<string, string> = {
    INPUT_MODE: "apply",
    INPUT_PATH: "./configuration",
    INPUT_REPOSITORY: "api-service",
    INPUT_FORMAT: "json",
    INPUT_VERBOSE: "true",
  };

  assertEquals(
    buildCliArguments(readActionInputs((name) => values[name])),
    [
      "apply",
      "api-service",
      "--path",
      "./configuration",
      "--format",
      "json",
      "--verbose",
    ],
  );
});

Deno.test("action omits an empty repository target", () => {
  const values: Record<string, string> = {
    INPUT_MODE: "plan",
    INPUT_REPOSITORY: "",
  };

  assertEquals(
    buildCliArguments(readActionInputs((name) => values[name])),
    ["plan", "--path", ".", "--format", "text"],
  );
});

Deno.test("action trims optional inputs", () => {
  const values: Record<string, string> = {
    INPUT_MODE: " plan ",
    INPUT_PATH: " ./configuration ",
    INPUT_REPOSITORY: "  ",
    INPUT_FORMAT: " json ",
    INPUT_VERBOSE: " FALSE ",
  };

  assertEquals(
    buildCliArguments(readActionInputs((name) => values[name])),
    ["plan", "--path", "./configuration", "--format", "json"],
  );
});

Deno.test("action rejects invalid verbose input", () => {
  assertThrows(
    () =>
      readActionInputs((name) =>
        name === "INPUT_MODE"
          ? "plan"
          : name === "INPUT_VERBOSE"
          ? "yes"
          : undefined
      ),
    Error,
    "Invalid verbose input",
  );
});

Deno.test("action accepts case-insensitive verbose values", () => {
  const values: Record<string, string> = {
    INPUT_MODE: "plan",
    INPUT_VERBOSE: "TrUe",
  };

  assertEquals(
    buildCliArguments(readActionInputs((name) => values[name])),
    ["plan", "--path", ".", "--format", "text", "--verbose"],
  );
});
