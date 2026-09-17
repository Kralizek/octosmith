import { assertStringIncludes } from "@std/assert";
import { usage, VERSION } from "./mod.ts";

Deno.test("usage identifies OctoSmith", () => {
  assertStringIncludes(usage(), "octosmith");
});

Deno.test("version comes from package metadata", () => {
  assertStringIncludes(VERSION, "0.1.0");
});
