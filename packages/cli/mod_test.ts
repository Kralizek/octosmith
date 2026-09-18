import { assertEquals, assertStringIncludes } from "@std/assert";
import { main, type ReconciliationRuntime, usage, VERSION } from "./mod.ts";

Deno.test("usage identifies OctoSmith", () => {
  assertStringIncludes(usage(), "octosmith");
  assertStringIncludes(usage(), "plan");
  assertStringIncludes(usage(), "apply");
});

Deno.test("version comes from package metadata", () => {
  assertStringIncludes(VERSION, "0.1.0");
});


Deno.test("missing GITHUB_TOKEN returns a clear CLI failure", async () => {
  const previous = Deno.env.get("GITHUB_TOKEN");
  const errors: string[] = [];
  const originalError = console.error;

  try {
    Deno.env.delete("GITHUB_TOKEN");
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };

    assertStringIncludes(String(await main(["plan"])), "1");
    assertStringIncludes(errors.join("\n"), "GITHUB_TOKEN is required");
  } finally {
    console.error = originalError;
    if (previous === undefined) {
      Deno.env.delete("GITHUB_TOKEN");
    } else {
      Deno.env.set("GITHUB_TOKEN", previous);
    }
  }
});

Deno.test("invalid collection mode fails before invoking the runtime", async () => {
  let calls = 0;
  const runtime: ReconciliationRuntime = {
    discover() {
      calls++;
      throw new Error("should not run");
    },
    read() {
      calls++;
      throw new Error("should not run");
    },
    apply() {
      calls++;
      throw new Error("should not run");
    },
  };

  assertEquals(
    await main(
      ["plan", "--collections", "invalid"],
      { runtime },
    ),
    1,
  );
  assertEquals(calls, 0);
});
