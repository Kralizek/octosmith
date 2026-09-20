import { main } from "../packages/cli/mod.ts";

export interface ActionInputs {
  readonly mode: string;
  readonly path: string;
  readonly repository?: string;
  readonly format: string;
  readonly verbose: boolean;
}

export function readActionInputs(
  get: (name: string) => string | undefined = (name) => Deno.env.get(name),
): ActionInputs {
  const mode = required(get, "INPUT_MODE");
  const path = optional(get, "INPUT_PATH") ?? ".";
  const repository = optional(get, "INPUT_REPOSITORY");
  const format = optional(get, "INPUT_FORMAT") ?? "text";
  const verbose = parseBoolean(get("INPUT_VERBOSE") ?? "false", "verbose");

  return {
    mode,
    path,
    ...(repository !== undefined && repository.length > 0 && { repository }),
    format,
    verbose,
  };
}

export function buildCliArguments(inputs: ActionInputs): string[] {
  return [
    inputs.mode,
    ...(inputs.repository !== undefined ? [inputs.repository] : []),
    "--path",
    inputs.path,
    "--format",
    inputs.format,
    ...(inputs.verbose ? ["--verbose"] : []),
  ];
}

function required(
  get: (name: string) => string | undefined,
  name: string,
): string {
  const value = get(name)?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error(
      "Missing required action input: " + name.slice(6).toLowerCase(),
    );
  }

  return value;
}

function optional(
  get: (name: string) => string | undefined,
  name: string,
): string | undefined {
  const value = get(name)?.trim();

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error("Invalid " + name + " input: expected true or false");
}

if (import.meta.main) {
  Deno.exit(await main(buildCliArguments(readActionInputs())));
}
