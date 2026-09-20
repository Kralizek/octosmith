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
  const path = get("INPUT_PATH") ?? ".";
  const repository = get("INPUT_REPOSITORY");
  const format = get("INPUT_FORMAT") ?? "text";
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
  const value = get(name);

  if (value === undefined || value.length === 0) {
    throw new Error("Missing required action input: " + name.slice(6).toLowerCase());
  }

  return value;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error("Invalid " + name + " input: expected true or false");
}

if (import.meta.main) {
  Deno.exit(await main(buildCliArguments(readActionInputs())));
}
