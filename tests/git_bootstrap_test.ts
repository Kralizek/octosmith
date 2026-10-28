import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  buildFileOperations,
  type GitBootstrapRequest,
  type GitCommand,
  INITIAL_COMMIT_IDENTITY,
  LocalGitBootstrap,
  runGitCommand,
} from "@octosmith/octosmith";

const request: GitBootstrapRequest = {
  organization: "acme",
  repository: "api-orders",
  branch: "release/initial",
  files: [],
  assertEmpty: () => Promise.resolve(),
};

function fakeGit(command: GitCommand) {
  return Promise.resolve({
    code: 0,
    stdout: command.args[0] === "rev-parse" || command.args[0] === "hash-object"
      ? "a".repeat(40) + "\n"
      : "",
    stderr: "",
  });
}

for (
  const baseUrl of [
    "http://github.example.com/api/v3",
    "https://user:PRIVATE-TOKEN@github.example.com/api/v3",
    "https://api.github.com?access_token=PRIVATE-TOKEN",
    "https://github.example.com/api/v3?credential=PRIVATE-TOKEN",
    "https://api.github.com#PRIVATE-TOKEN",
    "https://github.example.com/api/v3#PRIVATE-TOKEN",
    "invalid",
  ]
) {
  Deno.test(
    "bootstrap rejects invalid transport URL without credentials or Git: " +
      baseUrl.split("@").at(-1),
    async () => {
      let calls = 0;
      const forbidden = (): never => {
        calls++;
        throw new Error("Must not execute");
      };
      const result = await new LocalGitBootstrap({
        baseUrl,
        token: forbidden,
        run: forbidden,
        makeTempDirectory: forbidden,
      }).bootstrap(request);
      assertEquals(result.failure, "preparation");
      assertEquals(result.pushAttempted, false);
      assertEquals(calls, 0);
      assert(!JSON.stringify(result).includes("PRIVATE-TOKEN"));
    },
  );
}

for (
  const { baseUrl, gitOrigin, empty } of [
    { baseUrl: undefined, gitOrigin: "https://github.com" },
    {
      baseUrl: "https://github.example.com/api/v3",
      gitOrigin: "https://github.example.com",
    },
  ].flatMap((host) => [false, true].map((empty) => ({ ...host, empty })))
) {
  Deno.test(`local Git bootstrap creates one exact commit and one push (empty=${empty}, host=${gitOrigin})`, async () => {
    const root = await Deno.makeTempDir();
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
    const globalConfig = join(root, "host.gitconfig");
    const hostConfiguration =
      "[user]\n\tname = Host Identity\n\temail = host@example.test\n";
    await Deno.writeTextFile(globalConfig, hostConfiguration);
    const previousGlobalConfig = Deno.env.get("GIT_CONFIG_GLOBAL");
    Deno.env.set("GIT_CONFIG_GLOBAL", globalConfig);
    const commands: GitCommand[] = [];
    const token = "CREDENTIAL-SENTINEL&|%!^<>()";
    const env = {
      PATH: Deno.env.get("PATH") ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: Deno.build.os === "windows" ? "NUL" : "/dev/null",
      ...(Deno.build.os === "windows" &&
        { SYSTEMROOT: Deno.env.get("SYSTEMROOT") ?? "" }),
    };
    const inspect = async (...args: string[]) => {
      const output = await runGitCommand({ cwd: root, args, env });
      assertEquals(output.code, 0, output.stderr);
      return output.stdout.trim();
    };
    try {
      await inspect(
        "init",
        "--bare",
        "--initial-branch=release/initial",
        remote,
      );
      const files = empty ? [] : [
        {
          path: "README.md",
          ensure: "exists" as const,
          content: "hello\r\nworld\r\n",
        },
        {
          path: "-README.md",
          ensure: "exact" as const,
          content: "leading dash\n",
        },
        {
          path: "-comma,name.txt",
          ensure: "exact" as const,
          content: "leading dash and comma\n",
        },
        {
          path: "nested/utf8.txt",
          ensure: "exact" as const,
          content: "caf\u00e9\nno-final-newline",
        },
        { path: "obsolete.txt", ensure: "absent" as const },
        { path: ".gitignore", ensure: "exact" as const, content: "*\n" },
        {
          path: ".gitattributes",
          ensure: "exact" as const,
          content: "* text eol=lf\n",
        },
      ];
      const bootstrap = new LocalGitBootstrap({
        token: () => token,
        baseUrl,
        makeTempDirectory: async () => {
          await Deno.mkdir(workspace);
          return workspace;
        },
        run: async (command) => {
          commands.push(command);
          assert(!command.args.join(" ").includes(token));
          assertEquals(command.env.GIT_CONFIG_NOSYSTEM, "1");
          assertEquals(command.env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_GLOBAL);
          assertEquals(command.env.GIT_TRACE, undefined);
          if (command.args[0] === "remote") {
            assertEquals(
              command.args.at(-1),
              gitOrigin + "/acme/api-orders.git",
            );
            return await runGitCommand({
              ...command,
              args: [...command.args.slice(0, -1), remote],
            });
          }
          if (command.args.includes("push")) {
            const config = await Deno.readTextFile(
              join(command.cwd, ".git/config"),
            );
            const askpass = await Deno.readTextFile(command.env.GIT_ASKPASS);
            assert(!config.includes(token));
            assert(!askpass.includes(token));
            assert(command.env.GIT_ASKPASS.endsWith(
              Deno.build.os === "windows" ? ".cmd" : ".sh",
            ));
            const credentialProcess = new Deno.Command(
              "git",
              {
                args: ["credential", "fill"],
                cwd: command.cwd,
                clearEnv: true,
                env: command.env,
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
              },
            ).spawn();
            const input = credentialProcess.stdin.getWriter();
            await input.write(new TextEncoder().encode(
              "protocol=https\nhost=credential-test.invalid\n\n",
            ));
            await input.close();
            const credential = await credentialProcess.output();
            assertEquals(credential.code, 0);
            const credentialOutput = new TextDecoder().decode(
              credential.stdout,
            );
            assert(credentialOutput.includes("username=x-access-token"));
            assert(credentialOutput.includes("password=" + token));
            assertEquals(command.env.OCTOSMITH_GIT_TOKEN, token);
            assertEquals(
              command.args.at(-1),
              "HEAD:refs/heads/release/initial",
            );
          } else {
            assertEquals(command.env.OCTOSMITH_GIT_TOKEN, undefined);
          }
          return await runGitCommand(command);
        },
      });
      const result = await bootstrap.bootstrap({ ...request, files });
      assertEquals(result.outcome, "completed", JSON.stringify(result));
      assertEquals(
        result.fileCount,
        files.filter((file) => file.ensure !== "absent").length,
      );
      assertEquals(result.prepared, true);
      assertEquals(result.commitCreated, true);
      assertEquals(result.pushAttempted, true);
      assertEquals(result.pushConfirmed, true);
      assertEquals(
        commands.filter(({ args }) => args[0] === "commit").length,
        1,
      );
      assertEquals(
        commands.filter(({ args }) => args.includes("push")).length,
        1,
      );
      assert(
        commands.filter(({ args }) => args[0] === "config").every((
          { args },
        ) => args[1] === "--local"),
      );
      assertEquals(
        await inspect(
          "--git-dir=" + remote,
          "rev-list",
          "--count",
          "refs/heads/release/initial",
        ),
        "1",
      );
      assertEquals(
        await inspect(
          "--git-dir=" + remote,
          "log",
          "-1",
          "--format=%an|%ae|%cn|%ce|%s",
        ),
        `Octosmith|${INITIAL_COMMIT_IDENTITY.email}|Octosmith|${INITIAL_COMMIT_IDENTITY.email}|Initial repository bootstrap`,
      );
      assertEquals(
        await inspect(
          "--git-dir=" + remote,
          "rev-parse",
          "refs/heads/release/initial",
        ),
        result.commitSha,
      );
      const paths = await inspect(
        "--git-dir=" + remote,
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
      );
      assertEquals(
        paths ? paths.split("\n") : [],
        files.filter((file) => file.ensure !== "absent").map((file) =>
          file.path
        ).sort(),
      );
      const current = [];
      for (const file of files) {
        if (file.ensure === "absent") continue;
        const output = await runGitCommand({
          cwd: root,
          args: ["--git-dir=" + remote, "show", "HEAD:" + file.path],
          env,
        });
        assertEquals(output.code, 0);
        assertEquals(output.stdout, file.content);
        current.push({
          path: file.path,
          content: output.stdout,
          sha: "blob",
        });
      }
      assertEquals(buildFileOperations(current, files), []);
      await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
      assert(!JSON.stringify(result).includes(token));
      assertEquals(await Deno.readTextFile(globalConfig), hostConfiguration);
    } finally {
      if (previousGlobalConfig === undefined) {
        Deno.env.delete("GIT_CONFIG_GLOBAL");
      } else Deno.env.set("GIT_CONFIG_GLOBAL", previousGlobalConfig);
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (
  const path of [
    "",
    "/absolute",
    "../escape",
    "a/../../escape",
    "a//b",
    "./file",
    ".git/config",
    "nested/.GIT/hooks/pre-push",
    "a\\..\\escape",
    "C:/escape",
    ".git./config",
    "git~1/config",
    ".gi\u200ct/config",
    "file\0name",
    'foo"bar',
    "foo*bar",
    "foo?bar",
    "foo<bar",
    "foo>bar",
    "foo|bar",
  ]
) {
  Deno.test(
    "bootstrap rejects unsafe path before workspace/Git: " +
      JSON.stringify(path),
    async () => {
      const result = await new LocalGitBootstrap({
        token: () => {
          throw new Error("must not fetch credentials");
        },
        makeTempDirectory: () => {
          throw new Error("must not create workspace");
        },
        run: () => {
          throw new Error("must not run Git");
        },
      }).bootstrap({
        ...request,
        files: [{ path, ensure: "exact", content: "private" }],
      });
      assertEquals(result.failure, "invalid_files");
      assertEquals(result.pushAttempted, false);
    },
  );
}

for (
  const stage of [
    "temp",
    "init",
    "config",
    "commit",
    "rejected",
    "unknown",
    "auth_push",
    "throw",
    "auth",
    "existing",
    "cleanup",
  ] as const
) {
  Deno.test(
    "bootstrap failure is safe and cleans workspace: " + stage,
    async () => {
      let workspace: string | undefined;
      let pushes = 0;
      let cleanup = false;
      const service = new LocalGitBootstrap({
        makeTempDirectory: async () => {
          if (stage === "temp") throw new Error("PRIVATE-ERROR");
          workspace = await Deno.makeTempDir();
          return workspace;
        },
        token: () => {
          if (stage === "auth") throw new Error("PRIVATE-ERROR");
          return "PRIVATE-TOKEN";
        },
        run: (command) => {
          if (command.args.includes("push")) {
            pushes++;
            if (stage === "throw") {
              throw new Error("PRIVATE-ERROR PRIVATE-TOKEN");
            }
            if (
              stage === "rejected" || stage === "unknown" ||
              stage === "auth_push"
            ) {
              return Promise.resolve({
                code: 1,
                stdout: "",
                stderr: stage === "auth_push"
                  ? "The requested URL returned error: 403 PRIVATE-TOKEN"
                  : stage === "rejected"
                  ? "! [remote rejected] HEAD (policy) PRIVATE-TOKEN"
                  : "connection lost PRIVATE-TOKEN PRIVATE-ERROR",
              });
            }
          }
          if (command.args[0] === stage) {
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "PRIVATE-TOKEN PRIVATE-ERROR",
            });
          }
          return fakeGit(command);
        },
        cleanup: async (path) => {
          cleanup = true;
          if (stage === "cleanup" || stage === "commit") {
            throw new Error("PRIVATE-ERROR");
          }
          await Deno.remove(path, { recursive: true });
        },
      });
      try {
        const result = await service.bootstrap({
          ...request,
          assertEmpty: () => {
            if (stage === "existing") throw new Error("Existing branch");
            return Promise.resolve();
          },
        });
        const failures = {
          temp: "preparation",
          init: "initialization",
          config: "initialization",
          commit: "commit",
          rejected: "push_rejected",
          unknown: "push_unknown",
          throw: "push_unknown",
          auth: "authentication",
          auth_push: "authentication",
          existing: "preparation",
          cleanup: "cleanup",
        };
        assertEquals(result.failure, failures[stage]);
        assertEquals(
          pushes,
          ["rejected", "unknown", "auth_push", "throw", "cleanup"].includes(
              stage,
            )
            ? 1
            : 0,
        );
        assertEquals(result.pushAttempted, pushes === 1);
        assertEquals(
          result.outcome,
          ["unknown", "throw"].includes(stage) ? "unknown" : "failed",
        );
        assertEquals(
          result.cleanupFailed,
          ["cleanup", "commit"].includes(stage) ? true : undefined,
        );
        assertEquals(cleanup, stage !== "temp");
        assert(!JSON.stringify(result).includes("PRIVATE"));
        if (workspace && !result.cleanupFailed) {
          await assertRejects(
            () => Deno.stat(workspace!),
            Deno.errors.NotFound,
          );
        }
      } finally {
        if (
          workspace && (stage === "cleanup" || stage === "commit")
        ) await Deno.remove(workspace, { recursive: true });
      }
    },
  );
}

Deno.test("Git rejects malformed branch without a push or shell interpolation", async () => {
  const result = await new LocalGitBootstrap({ token: () => "unused" })
    .bootstrap({ ...request, branch: "bad;$(echo injected):branch" });
  assertEquals(result.failure, "initialization");
  assertEquals(result.pushAttempted, false);
});
