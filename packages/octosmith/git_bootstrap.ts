import { dirname, join } from "@std/path";
import type { DesiredFile } from "./state/types.ts";
import { assertManagedFilePath } from "./state/file_path.ts";

/** Stable identity and message used for the single initial commit. */
export const INITIAL_COMMIT_IDENTITY = {
  name: "Octosmith",
  email: "octosmith@users.noreply.github.com",
  message: "Initial repository bootstrap",
} as const;

/** Safe failure categories; raw subprocess diagnostics are never returned. */
export type GitBootstrapFailure =
  | "preparation"
  | "invalid_files"
  | "initialization"
  | "commit"
  | "authentication"
  | "push_rejected"
  | "push_unknown"
  | "cleanup";

/** Observable bootstrap progress, including uncertain remote outcomes. */
export interface GitBootstrapResult {
  readonly branch: string;
  readonly fileCount: number;
  readonly prepared: boolean;
  readonly commitCreated: boolean;
  readonly commitSha?: string;
  readonly pushAttempted: boolean;
  readonly pushConfirmed: boolean;
  readonly outcome: "completed" | "failed" | "unknown";
  readonly failure?: GitBootstrapFailure;
  readonly cleanupFailed?: boolean;
}

/** Fully resolved content and identity; no template/name resolution occurs here. */
export interface GitBootstrapRequest {
  readonly organization: string;
  readonly repository: string;
  readonly branch: string;
  readonly files: readonly DesiredFile[];
  readonly assertEmpty: () => Promise<void>;
}

/** Injectable one-shot Git bootstrap transport. */
export interface RepositoryGitBootstrap {
  bootstrap(request: GitBootstrapRequest): Promise<GitBootstrapResult>;
}

/** Subprocess input for isolated Git execution without a shell. */
export interface GitCommand {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Captured diagnostics remain private to the bootstrap implementation. */
export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Authentication and execution dependencies for the local bootstrap service. */
export interface LocalGitBootstrapOptions {
  readonly token: () => string | Promise<string>;
  readonly run?: (command: GitCommand) => Promise<GitCommandResult>;
  readonly makeTempDirectory?: () => Promise<string>;
  readonly cleanup?: (path: string) => Promise<void>;
}

/** Execute Git with only explicitly supplied environment and captured output. */
export async function runGitCommand(
  command: GitCommand,
): Promise<GitCommandResult> {
  const output = await new Deno.Command("git", {
    args: [...command.args],
    cwd: command.cwd,
    clearEnv: true,
    env: command.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/** Materialize resolved files, commit once (even empty), and push at most once. */
export class LocalGitBootstrap implements RepositoryGitBootstrap {
  constructor(readonly options: LocalGitBootstrapOptions) {}

  async bootstrap(request: GitBootstrapRequest): Promise<GitBootstrapResult> {
    let workspace: string | undefined;
    let failure: GitBootstrapFailure = "preparation";
    let state: GitBootstrapResult = {
      branch: request.branch,
      fileCount:
        request.files.filter((file) => file.ensure !== "absent").length,
      prepared: false,
      commitCreated: false,
      pushAttempted: false,
      pushConfirmed: false,
      outcome: "failed",
    };
    try {
      failure = "invalid_files";
      const paths = new Set<string>();
      for (const file of request.files) {
        assertManagedFilePath(file.path);
        const key = file.path.toLowerCase();
        if (paths.has(key)) throw new Error("Duplicate managed path");
        paths.add(key);
        if (file.ensure !== "absent" && typeof file.content !== "string") {
          throw new Error("Missing resolved file content");
        }
      }
      failure = "preparation";
      workspace = await (this.options.makeTempDirectory?.() ??
        Deno.makeTempDir({ prefix: "octosmith-create-" }));
      const tree = join(workspace, "repository");
      await Deno.mkdir(tree);
      const env: Record<string, string> = {
        PATH: Deno.env.get("PATH") ?? "",
        ...(Deno.build.os === "windows" &&
          { SYSTEMROOT: Deno.env.get("SYSTEMROOT") ?? "" }),
        HOME: workspace,
        XDG_CONFIG_HOME: workspace,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: Deno.build.os === "windows" ? "NUL" : "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: INITIAL_COMMIT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: INITIAL_COMMIT_IDENTITY.email,
        GIT_COMMITTER_NAME: INITIAL_COMMIT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: INITIAL_COMMIT_IDENTITY.email,
        LC_ALL: "C",
      };
      const run = this.options.run ?? runGitCommand;
      const git = async (args: readonly string[]) => {
        const output = await run({ cwd: tree, args, env });
        if (output.code !== 0) throw new Error("Git operation failed");
        return output.stdout.trim();
      };
      failure = "initialization";
      await git(["check-ref-format", "--branch", request.branch]);
      await git(["init", "--initial-branch=" + request.branch, "--template="]);
      for (
        const [key, value] of [
          ["user.name", INITIAL_COMMIT_IDENTITY.name],
          ["user.email", INITIAL_COMMIT_IDENTITY.email],
          ["commit.gpgsign", "false"],
          ["core.autocrlf", "false"],
          ["core.hooksPath", join(workspace, "no-hooks")],
          ["credential.helper", ""],
        ]
      ) {
        await git(["config", "--local", key, value]);
      }
      failure = "invalid_files";
      for (const file of request.files) {
        if (file.ensure === "absent") continue;
        const destination = join(tree, file.path);
        await Deno.mkdir(dirname(destination), { recursive: true });
        await Deno.writeTextFile(destination, file.content!);
      }
      state = { ...state, prepared: true };
      failure = "commit";
      // Stage raw blobs: .gitattributes must not transform already resolved bytes.
      for (const file of request.files) {
        if (file.ensure === "absent") continue;
        const blob = await git([
          "hash-object",
          "-w",
          "--no-filters",
          "--",
          file.path,
        ]);
        await git([
          "update-index",
          "--add",
          "--cacheinfo",
          "100644",
          blob,
          file.path,
        ]);
      }
      await git([
        "commit",
        "--allow-empty",
        "-m",
        INITIAL_COMMIT_IDENTITY.message,
      ]);
      state = { ...state, commitCreated: true };
      const commitSha = await git(["rev-parse", "HEAD"]);
      if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) {
        throw new Error("Invalid commit");
      }
      state = { ...state, commitSha };
      failure = "preparation";
      await request.assertEmpty();
      failure = "authentication";
      const token = await this.options.token();
      if (!token.trim() || /[\r\n\0]/.test(token)) {
        throw new Error("Invalid token");
      }
      failure = "preparation";
      // Static askpass contains no credential. Only the push child receives it.
      const askpass = join(workspace, "askpass.sh");
      await Deno.writeTextFile(
        askpass,
        '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "x-access-token" ;;\n*Password*) printf "%s\\n" "$OCTOSMITH_GIT_TOKEN" ;;\n*) exit 1 ;;\nesac\n',
        { mode: 0o700 },
      );
      failure = "initialization";
      await git([
        "remote",
        "add",
        "origin",
        "https://github.com/" + encodeURIComponent(request.organization) + "/" +
        encodeURIComponent(request.repository) + ".git",
      ]);
      failure = "push_unknown";
      state = { ...state, pushAttempted: true };
      const pushed = await run({
        cwd: tree,
        args: [
          "-c",
          "http.followRedirects=false",
          "push",
          "--porcelain",
          "origin",
          "HEAD:refs/heads/" + request.branch,
        ],
        env: { ...env, GIT_ASKPASS: askpass, OCTOSMITH_GIT_TOKEN: token },
      });
      if (pushed.code !== 0) {
        const diagnostic = pushed.stdout + "\n" + pushed.stderr;
        failure =
          /Authentication failed|could not read Username|(?:HTTP |returned error: )(401|403)|Write access .* not granted|Permission .* denied|Repository not found/i
              .test(diagnostic)
            ? "authentication"
            : /\[rejected\]|\[remote rejected\]/.test(diagnostic)
            ? "push_rejected"
            : "push_unknown";
        throw new Error("Push failed");
      }
      state = { ...state, pushConfirmed: true, outcome: "completed" };
    } catch {
      state = {
        ...state,
        failure,
        outcome: failure === "push_unknown" ? "unknown" : "failed",
      };
    } finally {
      if (workspace !== undefined) {
        try {
          await (this.options.cleanup?.(workspace) ??
            Deno.remove(workspace, { recursive: true }));
        } catch {
          state = {
            ...state,
            cleanupFailed: true,
            ...(state.failure === undefined && {
              failure: "cleanup",
              outcome: "failed",
            }),
          };
        }
      }
    }
    return state;
  }
}
