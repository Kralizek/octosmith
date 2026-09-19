import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseOutputFormat, renderOutput } from "./output.ts";

Deno.test("parseOutputFormat accepts supported formats", () => {
  assertEquals(parseOutputFormat("text"), "text");
  assertEquals(parseOutputFormat("json"), "json");
});

Deno.test("parseOutputFormat rejects unsupported formats", () => {
  let message: string | undefined;
  try {
    parseOutputFormat("yaml");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assertEquals(
    message,
    "Unsupported output format: yaml. Expected text or json",
  );
});

Deno.test("renderOutput serializes dates as ISO strings in JSON", () => {
  const rendered = renderOutput(
    "json",
    { startedAt: new Date("2026-09-19T10:00:00Z") },
    () => "text",
  );

  assertStringIncludes(rendered, '"startedAt": "2026-09-19T10:00:00.000Z"');
});

Deno.test("renderOutput delegates text rendering", () => {
  assertEquals(
    renderOutput("text", { value: 42 }, (value) => "value=" + value.value),
    "value=42",
  );
});
