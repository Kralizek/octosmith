/** Describes output format. */
export type OutputFormat = "text" | "json";

/** Parse a CLI output format value. */
export function parseOutputFormat(value: string): OutputFormat {
  switch (value) {
    case "text":
    case "json":
      return value;
    default:
      throw new Error(
        "Unsupported output format: " + value + ". Expected text or json",
      );
  }
}

/** Render a value using the selected CLI output format. */
export function renderOutput<T>(
  format: OutputFormat,
  value: T,
  renderText: (value: T) => string,
): string {
  switch (format) {
    case "text":
      return renderText(value);
    case "json":
      return JSON.stringify(value, null, 2);
  }
}
