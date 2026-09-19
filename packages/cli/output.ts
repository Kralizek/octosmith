export type OutputFormat = "text" | "json";

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
