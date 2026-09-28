/** Credential sources used by the CLI when creating a GitHub runtime. */
export interface GitHubTokenOptions {
  readonly explicitToken?: string;
  readonly getEnv?: (name: string) => string | undefined;
  readonly runGhAuthToken?: (
    args: readonly string[],
  ) => Promise<Deno.CommandOutput>;
}

/** Resolve a GitHub token without involving the core planning API. */
export async function resolveGitHubToken(
  options: GitHubTokenOptions = {},
): Promise<string> {
  if (options.explicitToken !== undefined) {
    const token = options.explicitToken.trim();
    if (!token) {
      throw new Error("Explicit GitHub token is empty");
    }
    return token;
  }

  const getEnv = options.getEnv ?? Deno.env.get;
  const environmentToken = getEnv("GITHUB_TOKEN");
  if (environmentToken !== undefined) {
    const token = environmentToken.trim();
    if (!token) {
      throw new Error("GITHUB_TOKEN is empty");
    }
    return token;
  }

  if (getEnv("GITHUB_ACTIONS") !== undefined) {
    throw new Error("GITHUB_TOKEN is required to access GitHub in Actions");
  }

  let result: Deno.CommandOutput;
  try {
    result = await (options.runGhAuthToken ?? ((args) =>
      new Deno.Command("gh", {
        args: [...args],
        stdout: "piped",
        stderr: "piped",
      }).output()))(["auth", "token", "--hostname", "github.com"]);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        "GitHub authentication unavailable: gh is not installed. Set GITHUB_TOKEN or install gh and run gh auth login.",
      );
    }
    throw new Error(
      "GitHub authentication failed: could not run gh auth token. Set GITHUB_TOKEN or retry gh auth login.",
    );
  }

  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr);
    if (
      /not logged (?:in|into)|not authenticated|gh auth login/i.test(stderr)
    ) {
      throw new Error(
        "GitHub authentication unavailable: gh is not authenticated. Run gh auth login or set GITHUB_TOKEN.",
      );
    }
    throw new Error(
      `GitHub authentication failed: gh auth token exited with code ${result.code}. Set GITHUB_TOKEN or check gh auth status.`,
    );
  }

  const token = new TextDecoder().decode(result.stdout).trim();
  if (!token) {
    throw new Error(
      "GitHub authentication failed: gh auth token returned an empty token. Run gh auth login or set GITHUB_TOKEN.",
    );
  }
  return token;
}
