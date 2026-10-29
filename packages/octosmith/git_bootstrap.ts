import { dirname, join } from "@std/path";
import type { DesiredFile } from "./state/types.ts";
import { assertManagedFilePath } from "./state/file_path.ts";
import type { PostCreateCommand } from "./configuration/types.ts";

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
  | "post_create_command"
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
  /** One-based ordinal only; executable arguments and diagnostics stay private. */
  readonly failedCommand?: number;
  readonly cleanupFailed?: boolean;
}

/** Fully resolved content and identity; no template/name resolution occurs here. */
export interface GitBootstrapRequest {
  readonly organization: string;
  readonly repository: string;
  readonly branch: string;
  readonly files: readonly DesiredFile[];
  readonly postCreateCommands?: readonly PostCreateCommand[];
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

/** Direct executable invocation in the isolated bootstrap environment. */
export interface PostCreateCommandInvocation extends GitCommand {
  readonly command: string;
}

/** Authentication and execution dependencies for the local bootstrap service. */
export interface LocalGitBootstrapOptions {
  readonly token: () => string | Promise<string>;
  /** GitHub API base URL; enterprise Git remotes use the same HTTPS origin. */
  readonly baseUrl?: string;
  readonly run?: (command: GitCommand) => Promise<GitCommandResult>;
  readonly runPostCreateCommand?: (
    command: PostCreateCommandInvocation,
  ) => Promise<GitCommandResult>;
  readonly makeTempDirectory?: () => Promise<string>;
  readonly cleanup?: (path: string) => Promise<void>;
}

/** Execute Git with only explicitly supplied environment and captured output. */
export async function runGitCommand(
  command: GitCommand,
): Promise<GitCommandResult> {
  return await runPostCreateCommand({ ...command, command: "git" });
}

/** Run without a shell or interactive input; never stream subprocess output. */
export async function runPostCreateCommand(
  command: PostCreateCommandInvocation,
): Promise<GitCommandResult> {
  const output = await new Deno.Command(command.command, {
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

interface BootstrapFile {
  readonly path: string;
  readonly mode: string;
}

async function readBootstrapFiles(
  tree: string,
  declarations: ReadonlyMap<string, string>,
): Promise<BootstrapFile[]> {
  const files: BootstrapFile[] = [];
  const paths = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix + entry.name;
      const info = await Deno.lstat(join(tree, path));
      // Only the actual root Git directory is excluded, never aliases or links.
      if (path === ".git" && info.isDirectory && !info.isSymlink) continue;
      assertManagedFilePath(path);
      const key = path.toLowerCase();
      const declared = declarations.get(key);
      if (declared !== undefined && declared !== path) {
        throw new Error("Generated path aliases a managed path");
      }
      if (paths.has(key)) throw new Error("Duplicate bootstrap path");
      paths.add(key);
      if (info.isSymlink) {
        throw new Error("Bootstrap symlinks are not supported");
      }
      if (info.isDirectory) {
        await visit(join(tree, path), path + "/");
      } else if (info.isFile) {
        files.push({
          path,
          mode: Deno.build.os !== "windows" && ((info.mode ?? 0) & 0o111) !== 0
            ? "100755"
            : "100644",
        });
      } else {
        throw new Error("Bootstrap paths must be regular files or directories");
      }
    }
  };
  await visit(tree, "");
  return files;
}

/** Materialize resolved files, commit once (even empty), and push at most once. */
export class LocalGitBootstrap implements RepositoryGitBootstrap {
  constructor(readonly options: LocalGitBootstrapOptions) {}

  async bootstrap(request: GitBootstrapRequest): Promise<GitBootstrapResult> {
    let workspace: string | undefined;
    let failure: GitBootstrapFailure = "preparation";
    let failedCommand: number | undefined;
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
      const api = new URL(this.options.baseUrl ?? "https://api.github.com");
      if (
        api.protocol !== "https:" || api.username || api.password ||
        api.search || api.hash
      ) {
        throw new Error(
          "Git bootstrap requires a credential-free HTTPS API URL",
        );
      }
      const gitOrigin = api.origin === "https://api.github.com"
        ? "https://github.com"
        : api.origin;
      failure = "invalid_files";
      const paths = new Set<string>();
      const declarations = new Map<string, string>();
      for (const file of request.files) {
        assertManagedFilePath(file.path);
        const key = file.path.toLowerCase();
        if (paths.has(key)) throw new Error("Duplicate managed path");
        paths.add(key);
        const parts = file.path.split("/");
        for (let count = 1; count <= parts.length; count++) {
          const path = parts.slice(0, count).join("/");
          const key = path.toLowerCase();
          const declared = declarations.get(key);
          if (declared !== undefined && declared !== path) {
            throw new Error("Managed paths have conflicting case");
          }
          declarations.set(key, path);
        }
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
        TMPDIR: workspace,
        TMP: workspace,
        TEMP: workspace,
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
        return output.stdout;
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
          ["credential.username", "x-access-token"],
        ]
      ) {
        await git(["config", "--local", key, value]);
      }
      failure = "post_create_command";
      const runCommand = this.options.runPostCreateCommand ??
        runPostCreateCommand;
      for (
        const [index, command] of (request.postCreateCommands ?? []).entries()
      ) {
        failedCommand = index + 1;
        const output = await runCommand({
          command: command.command,
          args: command.args ?? [],
          cwd: tree,
          env,
        });
        if (output.code !== 0) throw new Error("Post-create command failed");
      }
      failedCommand = undefined;
      failure = "invalid_files";
      await readBootstrapFiles(tree, declarations);
      for (const file of request.files) {
        if (file.ensure !== "absent") continue;
        const destination = join(tree, file.path);
        try {
          await Deno.remove(destination, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      for (const file of request.files) {
        if (file.ensure === "absent") continue;
        const destination = join(tree, file.path);
        await Deno.mkdir(dirname(destination), { recursive: true });
        await Deno.writeTextFile(destination, file.content!);
      }
      const files = await readBootstrapFiles(tree, declarations);
      state = { ...state, prepared: true };
      failure = "commit";
      // Discard any index entries left by generators. Discover ignored files
      // using Git, but stage raw blobs so attributes cannot run clean filters.
      await git(["read-tree", "--empty"]);
      const generated = new Set(
        (await git([
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])).split("\0").filter(Boolean),
      );
      const managed = new Set(
        request.files.filter((file) => file.ensure !== "absent").map((file) =>
          file.path
        ),
      );
      const staged = files.filter(({ path }) =>
        managed.has(path) || generated.has(path)
      );
      state = { ...state, fileCount: staged.length };
      for (const file of staged) {
        const blob = (await git([
          "hash-object",
          "-w",
          "--no-filters",
          "--",
          file.path,
        ])).trim();
        await git([
          "update-index",
          "--add",
          "--cacheinfo",
          `${
            managed.has(file.path) ? "100644" : file.mode
          },${blob},${file.path}`,
        ]);
      }
      // Porcelain commit refreshes the index and can invoke clean filters.
      // Plumbing preserves raw blobs and creates one root commit, even empty.
      const treeSha = (await git(["write-tree"])).trim();
      const commitSha = (await git([
        "commit-tree",
        treeSha,
        "-m",
        INITIAL_COMMIT_IDENTITY.message,
      ])).trim();
      if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) {
        throw new Error("Invalid commit");
      }
      state = { ...state, commitCreated: true, commitSha };
      const ref = "refs/heads/" + request.branch;
      await git(["update-ref", ref, commitSha, "0".repeat(commitSha.length)]);
      await git(["symbolic-ref", "HEAD", ref]);
      failure = "preparation";
      await request.assertEmpty();
      failure = "authentication";
      const token = await this.options.token();
      if (!token.trim() || /[\r\n\0]/.test(token)) {
        throw new Error("Invalid token");
      }
      failure = "preparation";
      // Static askpass contains no credential. Only the push child receives it.
      const windows = Deno.build.os === "windows";
      const askpass = join(workspace, windows ? "askpass.cmd" : "askpass.sh");
      await Deno.writeTextFile(
        askpass,
        windows
          ? '@echo off\r\n@"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine([Environment]::GetEnvironmentVariable(\'OCTOSMITH_GIT_TOKEN\'))"\r\n'
          : '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "x-access-token" ;;\n*Password*) printf "%s\\n" "$OCTOSMITH_GIT_TOKEN" ;;\n*) exit 1 ;;\nesac\n',
        windows ? {} : { mode: 0o700 },
      );
      failure = "initialization";
      await git([
        "remote",
        "add",
        "origin",
        gitOrigin + "/" + encodeURIComponent(request.organization) + "/" +
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
        ...(failedCommand !== undefined && { failedCommand }),
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
