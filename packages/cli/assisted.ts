import {
  type LoadedConfiguration,
  preflightRepositoryCreation,
  type RepositoryCreationInput,
  type RepositoryCreationOptions,
  type RepositoryCreationSpecification,
} from "@octosmith/octosmith";

/** Terminal interaction only; injecting prompts does not waive CLI TTY checks. */
export interface CreationPromptAdapter {
  readonly prompt: (message: string) => Promise<string | null>;
}

/** Read canonical terminal input and write questions to stderr, never stdout. */
export const terminalCreationPrompts: CreationPromptAdapter = {
  async prompt(message) {
    const encoder = new TextEncoder();
    await Deno.stderr.write(encoder.encode(message + "\n> "));
    const bytes: number[] = [];
    const buffer = new Uint8Array(1);
    try {
      while (await Deno.stdin.read(buffer) !== null) {
        if (buffer[0] === 3 || buffer[0] === 4) return null;
        if (buffer[0] === 10) {
          return new TextDecoder().decode(new Uint8Array(bytes)).replace(
            /\r$/,
            "",
          );
        }
        bytes.push(buffer[0]);
      }
    } catch (error) {
      if (
        !(error instanceof Deno.errors.BadResource) &&
        !(error instanceof Deno.errors.Interrupted)
      ) throw error;
    }
    return null;
  },
};

const visibilityDescriptions = {
  public: "Public - visible to everyone",
  private: "Private - restricted repository access",
  internal: "Internal - visible to enterprise members",
};

/** Collect only choices authorized by shared preflight; never access GitHub. */
export async function resolveAssistedRepositoryCreation(
  loaded: LoadedConfiguration,
  initial: RepositoryCreationInput,
  prompts: CreationPromptAdapter,
  writeError: (message: string) => void,
  options: RepositoryCreationOptions = {},
): Promise<RepositoryCreationSpecification> {
  let input = { ...initial };
  let manualName = false;
  while (true) {
    const specification = await preflightRepositoryCreation(
      loaded,
      input,
      options,
    );
    if (specification.ready) return specification;

    const correctableName = manualName &&
      specification.diagnostics.some(({ code }) =>
        code === "invalid_name" || code === "metadata_outside_intersection"
      ) &&
      specification.diagnostics.every(({ code }) =>
        code === "invalid_name" || code === "metadata_outside_intersection" ||
        code === "visibility_ambiguous"
      );
    if (correctableName) {
      writeError(
        specification.diagnostics.map(({ message }) => message).join("\n"),
      );
      input = { ...input, name: undefined };
      manualName = false;
      continue;
    }
    if (
      specification.diagnostics.some(({ code }) =>
        code !== "name_required" && code !== "ambiguous_name_strategy" &&
        code !== "visibility_ambiguous"
      )
    ) return specification;

    const { name, visibility } = specification.choices;
    if (name.status === "required" && initial.name === undefined) {
      input = {
        ...input,
        name: await answer("Repository name (type :cancel to cancel):"),
      };
      manualName = true;
    } else if (name.status === "ambiguous" && initial.name === undefined) {
      if (name.alternatives.length === 0) return specification;
      const selected = await select(
        "Choose a naming pattern",
        name.alternatives.map(({ pattern }) => pattern),
      );
      input = { ...input, namingStrategy: name.alternatives[selected].pattern };
    } else if (
      visibility.status === "ambiguous" && initial.visibility === undefined
    ) {
      if (visibility.alternatives.length === 0) return specification;
      const selected = await select(
        "Choose repository visibility",
        visibility.alternatives.map((value) => visibilityDescriptions[value]),
      );
      input = {
        ...input,
        visibility: visibility.alternatives[selected],
      };
    } else {
      return specification;
    }
  }

  async function answer(message: string): Promise<string> {
    const value = await prompts.prompt(message);
    if (value === null || value.trim() === ":cancel") {
      throw new Error(
        "Assisted creation cancelled; no repository was created.",
      );
    }
    return value;
  }

  async function select(
    title: string,
    alternatives: readonly string[],
  ): Promise<number> {
    while (true) {
      const value = await answer(
        title + " (type :cancel to cancel):\n" +
          alternatives.map((label, index) => `${index + 1}. ${label}`).join(
            "\n",
          ),
      );
      const index = Number(value.trim()) - 1;
      if (/^[1-9]\d*$/.test(value.trim()) && index < alternatives.length) {
        return index;
      }
      writeError(
        `Invalid selection. Enter a number from 1 to ${alternatives.length}.`,
      );
    }
  }
}
