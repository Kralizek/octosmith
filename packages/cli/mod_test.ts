import { assertEquals, assertStringIncludes } from "@std/assert";
import { main, usage, VERSION } from "./mod.ts";

Deno.test("usage identifies Octosmith", () => {
  assertStringIncludes(usage(), "octosmith");
  assertStringIncludes(usage(), "plan");
  assertStringIncludes(usage(), "apply");
  assertStringIncludes(usage(), "template");
  assertStringIncludes(usage(), "resource");
  assertEquals(usage().includes("-v, --version"), false);
});

Deno.test("version comes from package metadata", async () => {
  const metadata = JSON.parse(
    await Deno.readTextFile(new URL("./deno.json", import.meta.url)),
  );

  assertEquals(VERSION, metadata.version);
});

Deno.test("missing GITHUB_TOKEN returns a clear CLI failure", async () => {
  const previous = Deno.env.get("GITHUB_TOKEN");
  const errors: string[] = [];
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    Deno.env.delete("GITHUB_TOKEN");
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };
    globalThis.fetch = ((_input, _init) => {
      fetchCalls++;
      return Promise.reject(new Error("fetch must not be called"));
    }) as typeof globalThis.fetch;

    assertEquals(await main(["plan"]), 1);
    assertStringIncludes(errors.join("\n"), "GITHUB_TOKEN is required");
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (previous === undefined) {
      Deno.env.delete("GITHUB_TOKEN");
    } else {
      Deno.env.set("GITHUB_TOKEN", previous);
    }
  }
});

Deno.test("apply rejects combining a resource target with --plan", async () => {
  const errors: string[] = [];
  const originalError = console.error;

  try {
    console.error = (...values: unknown[]) => {
      errors.push(values.map(String).join(" "));
    };

    assertEquals(await main(["apply", "sample", "--plan", "plan.json"]), 1);
    assertStringIncludes(
      errors.join("\n"),
      "Cannot combine a resource target with --plan",
    );
  } finally {
    console.error = originalError;
  }
});
