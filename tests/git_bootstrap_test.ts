import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  buildFileOperations,
  type GitBootstrapRequest,
  type GitCommand,
  INITIAL_COMMIT_IDENTITY,
  LocalGitBootstrap,
  type PostCreateCommandInvocation,
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
    stdout:
      ["commit-tree", "write-tree", "hash-object"].includes(command.args[0])
        ? "a".repeat(40) + "\n"
        : "",
    stderr: "",
  });
}

for (
  const [caseNumber, baseUrl] of [
    "http://github.example.com/api/v3",
    "https://user:PRIVATE-TOKEN@github.example.com/api/v3",
    "https://api.github.com?access_token=PRIVATE-TOKEN",
    "https://github.example.com/api/v3?credential=PRIVATE-TOKEN",
    "https://api.github.com#PRIVATE-TOKEN",
    "https://github.example.com/api/v3#PRIVATE-TOKEN",
    "invalid",
  ].entries()
) {
  Deno.test(
    "bootstrap rejects invalid transport URL without credentials or Git #" +
      caseNumber,
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
        commands.filter(({ args }) => args[0] === "commit-tree").length,
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
          if (
            command.args[0] === (stage === "commit" ? "commit-tree" : stage)
          ) {
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

for (const empty of [false, true]) {
  Deno.test(`command output joins managed files in one raw initial commit (empty=${empty})`, async () => {
    const root = await Deno.makeTempDir();
    const remote = join(root, "remote.git");
    const workspace = join(root, "workspace");
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
      return output.stdout;
    };
    const commands: GitCommand[] = [];
    const hooks: PostCreateCommandInvocation[] = [];
    const diagnostics: string[] = [];
    let remoteChecks = 0;
    const files = empty
      ? [{ path: "removed.txt", ensure: "absent" as const }]
      : [
        { path: "managed.txt", ensure: "exact" as const, content: "exact\r\n" },
        {
          path: "exists.txt",
          ensure: "exists" as const,
          content: "exists\r\n",
        },
        {
          path: "managed-ignored.txt",
          ensure: "exact" as const,
          content: "forced\r\n",
        },
        { path: "removed.txt", ensure: "absent" as const },
        {
          path: ".gitignore",
          ensure: "exact" as const,
          content: "ignored-*\nmanaged-ignored.txt\n",
        },
        {
          path: ".gitattributes",
          ensure: "exact" as const,
          content: "* text eol=lf filter=must-not-run\n",
        },
      ];
    try {
      await inspect(
        "init",
        "--bare",
        "--initial-branch=release/initial",
        remote,
      );
      const result = await new LocalGitBootstrap({
        token: () => "PRIVATE-TOKEN",
        makeTempDirectory: async () => {
          await Deno.mkdir(workspace);
          return workspace;
        },
        runPostCreateCommand: async (command) => {
          hooks.push(command);
          assertEquals(command.cwd, join(workspace, "repository"));
          assertEquals(command.env.OCTOSMITH_GIT_TOKEN, undefined);
          assertEquals(command.env.GH_TOKEN, undefined);
          assertEquals(command.env.GITHUB_TOKEN, undefined);
          assertEquals(command.env.GIT_ASKPASS, undefined);
          assertEquals(command.env.HOME, workspace);
          if (hooks.length === 1) {
            assert(
              commands.some(({ args }) =>
                args[0] === "config" && args[2] === "user.email"
              ),
            );
            assertEquals(command.args, ["$LITERAL", "$(not-a-shell)", "a;b"]);
            await Deno.writeTextFile(
              join(command.cwd, ".git", "private-command-marker"),
              "Git internals must never be staged",
            );
            await Deno.writeTextFile(
              join(command.cwd, "removed.txt"),
              "remove",
            );
            await Deno.writeTextFile(
              join(command.cwd, "ignored-output.txt"),
              "ignored",
            );
            await Deno.writeTextFile(join(command.cwd, ".gitignore"), "*\n");
            if (!empty) {
              await Deno.writeTextFile(
                join(command.cwd, "managed.txt"),
                "generated",
              );
              await Deno.writeTextFile(
                join(command.cwd, "exists.txt"),
                "generated",
              );
              await Deno.writeTextFile(
                join(command.cwd, "generated.txt"),
                "raw\r\n",
              );
              await Deno.writeTextFile(
                join(command.cwd, " leading,-name.txt"),
                "space\r\n",
              );
              await Deno.writeFile(
                join(command.cwd, "binary.bin"),
                new Uint8Array([0, 1, 2]),
              );
              await Deno.writeTextFile(
                join(command.cwd, "executable"),
                "generated executable\n",
              );
              if (Deno.build.os !== "windows") {
                await Deno.chmod(join(command.cwd, "executable"), 0o755);
              }
              for (
                const [key, value] of [
                  ["filter.must-not-run.clean", "executable-that-must-not-run"],
                  ["filter.must-not-run.required", "true"],
                ]
              ) {
                assertEquals(
                  (await runGitCommand({
                    ...command,
                    args: ["config", "--local", key, value],
                  })).code,
                  0,
                );
              }
            }
            // Generators may stage files; the bootstrap must rebuild the index.
            assertEquals(
              (await runGitCommand({
                ...command,
                args: ["add", "--force", "--", "removed.txt"],
              })).code,
              0,
            );
          } else {
            assertEquals(command.args, []);
            assertEquals(
              await Deno.readTextFile(join(command.cwd, "removed.txt")),
              "remove",
            );
            if (!empty) {
              assertEquals(
                await Deno.readTextFile(join(command.cwd, "managed.txt")),
                "generated",
              );
            }
          }
          assert(!commands.some(({ args }) => args[0] === "hash-object"));
          return { code: 0, stdout: "PRIVATE-OUTPUT", stderr: "PRIVATE-ERROR" };
        },
        run: async (command) => {
          commands.push(command);
          if (command.args[0] === "remote") {
            return await runGitCommand({
              ...command,
              args: [...command.args.slice(0, -1), remote],
            });
          }
          const output = await runGitCommand(command);
          if (output.code !== 0) {
            diagnostics.push(command.args.join(" ") + ": " + output.stderr);
          }
          return output;
        },
      }).bootstrap({
        ...request,
        files,
        postCreateCommands: [
          {
            command: "first-generator",
            args: ["$LITERAL", "$(not-a-shell)", "a;b"],
          },
          { command: "second-generator" },
        ],
        assertEmpty: () => {
          remoteChecks++;
          assertEquals(hooks.length, 2);
          assertEquals(
            commands.filter(({ args }) => args[0] === "commit-tree").length,
            1,
          );
          return Promise.resolve();
        },
      });
      assertEquals(
        result.outcome,
        "completed",
        JSON.stringify({ result, diagnostics }),
      );
      assertEquals(hooks.map(({ command }) => command), [
        "first-generator",
        "second-generator",
      ]);
      assertEquals(result.failedCommand, undefined);
      assertEquals(result.pushAttempted, true);
      assertEquals(remoteChecks, 1);
      assertEquals(
        commands.filter(({ args }) => args.includes("push")).length,
        1,
      );
      assertEquals(
        (await inspect("--git-dir=" + remote, "rev-list", "--count", "HEAD"))
          .trim(),
        "1",
      );
      const expected = empty ? [] : [
        ...files.filter(({ ensure }) => ensure !== "absent").map(({ path }) =>
          path
        ),
        "generated.txt",
        " leading,-name.txt",
        "binary.bin",
        "executable",
      ];
      const committed = (await inspect(
        "--git-dir=" + remote,
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
      )).split("\0").filter(Boolean);
      assertEquals(committed.sort(), expected.sort());
      assertEquals(result.fileCount, expected.length);
      for (const file of files) {
        if (file.ensure === "absent") continue;
        assertEquals(
          await inspect("--git-dir=" + remote, "show", "HEAD:" + file.path),
          file.content,
        );
      }
      if (!empty) {
        assertEquals(
          await inspect("--git-dir=" + remote, "show", "HEAD:generated.txt"),
          "raw\r\n",
        );
        assertEquals(
          await inspect("--git-dir=" + remote, "show", "HEAD:binary.bin"),
          "\0\x01\x02",
        );
        const mode = await inspect(
          "--git-dir=" + remote,
          "ls-tree",
          "HEAD",
          "--",
          "executable",
        );
        assert(
          mode.startsWith(Deno.build.os === "windows" ? "100644" : "100755"),
        );
      }
      assert(!JSON.stringify(result).includes("PRIVATE"));
      await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (const launchFailure of [false, true]) {
  Deno.test(`post-create ${launchFailure ? "launch failure" : "nonzero exit"} stops immediately and cleans up`, async () => {
    const workspace = await Deno.makeTempDir();
    const commands: GitCommand[] = [];
    const hooks: PostCreateCommandInvocation[] = [];
    let cleaned = false;
    const result = await new LocalGitBootstrap({
      token: () => {
        throw new Error("Must not fetch credentials");
      },
      makeTempDirectory: () => Promise.resolve(workspace),
      run: (command) => {
        commands.push(command);
        return fakeGit(command);
      },
      runPostCreateCommand: (command) => {
        hooks.push(command);
        if (hooks.length === 2) {
          if (launchFailure) throw new Error("PRIVATE-ARGUMENT PRIVATE-OUTPUT");
          return Promise.resolve({
            code: 3,
            stdout: "PRIVATE-OUTPUT",
            stderr: "PRIVATE-ERROR",
          });
        }
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      cleanup: async (path) => {
        assertEquals(path, workspace);
        await assertRejects(
          () => Deno.stat(join(path, "repository", "managed.txt")),
          Deno.errors.NotFound,
        );
        await Deno.remove(path, { recursive: true });
        cleaned = true;
      },
    }).bootstrap({
      ...request,
      files: [{
        path: "managed.txt",
        ensure: "exact",
        content: "not yet materialized",
      }],
      postCreateCommands: ["first", "failed", "never"].map((command) => ({
        command,
        args: ["PRIVATE-ARGUMENT"],
      })),
      assertEmpty: () => {
        throw new Error("Must not reach push preflight");
      },
    });
    assertEquals(hooks.map(({ command }) => command), ["first", "failed"]);
    assertEquals(result.failure, "post_create_command");
    assertEquals(result.failedCommand, 2);
    assertEquals(result.prepared, false);
    assertEquals(result.commitCreated, false);
    assertEquals(result.pushAttempted, false);
    assertEquals(result.outcome, "failed");
    assert(!JSON.stringify(result).includes("PRIVATE"));
    assert(
      commands.every(({ args }) =>
        ["check-ref-format", "init", "config"].includes(args[0])
      ),
    );
    assert(cleaned);
    await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
  });
}

Deno.test("native launch failure is redacted before materialization or push", async () => {
  let workspace = "";
  const result = await new LocalGitBootstrap({
    token: () => {
      throw new Error("Must not fetch credentials");
    },
    makeTempDirectory: async () => workspace = await Deno.makeTempDir(),
    run: fakeGit,
  }).bootstrap({
    ...request,
    postCreateCommands: [{
      command: "octosmith-test-executable-that-does-not-exist",
      args: ["PRIVATE-ARGUMENT"],
    }],
  });
  assertEquals(result.failure, "post_create_command");
  assertEquals(result.failedCommand, 1);
  assertEquals(result.pushAttempted, false);
  assertEquals(result.prepared, false);
  assert(!JSON.stringify(result).includes("PRIVATE"));
  await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
});

Deno.test("a command-created branch commit cannot be overwritten or pushed", async () => {
  let workspace = "";
  const result = await new LocalGitBootstrap({
    token: () => {
      throw new Error("Must not fetch credentials");
    },
    makeTempDirectory: async () => workspace = await Deno.makeTempDir(),
    runPostCreateCommand: async (command) =>
      await runGitCommand({
        ...command,
        args: ["commit", "--allow-empty", "-m", "Unexpected hook commit"],
      }),
  }).bootstrap({
    ...request,
    postCreateCommands: [{ command: "fake" }],
  });
  assertEquals(result.failure, "commit");
  assertEquals(result.pushAttempted, false);
  await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
});

for (const ensure of ["exact", "exists", "absent"] as const) {
  for (const generated of ["Managed.txt", "Nested/file.txt"]) {
    Deno.test(`generated case aliases of managed ${ensure} paths fail portably: ${generated}`, async () => {
      let workspace = "";
      const result = await new LocalGitBootstrap({
        token: () => {
          throw new Error("Must not fetch credentials");
        },
        makeTempDirectory: async () => workspace = await Deno.makeTempDir(),
        run: fakeGit,
        runPostCreateCommand: async ({ cwd }) => {
          if (generated.startsWith("Nested/")) {
            await Deno.mkdir(join(cwd, "Nested"));
          }
          await Deno.writeTextFile(join(cwd, generated), "generated");
          await Deno.writeTextFile(join(cwd, ".gitignore"), "*\n");
          return { code: 0, stdout: "", stderr: "" };
        },
      }).bootstrap({
        ...request,
        files: [{ path: generated.toLowerCase(), ensure, content: "managed" }],
        postCreateCommands: [{ command: "fake" }],
      });
      assertEquals(result.failure, "invalid_files");
      assertEquals(result.prepared, false);
      assertEquals(result.pushAttempted, false);
      await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
    });
  }
}

for (
  const path of [
    "nested/.git/config",
    "nested/.GIT/config",
    "git~1/config",
    ...(Deno.build.os === "windows" ? [] : [
      ".git./config",
      "con.txt",
      "unsafe\\name",
      "bad:name",
      "bad\nname",
      "case.txt",
      "link",
      ".git",
    ]),
  ]
) {
  Deno.test(
    "generated paths are validated even when ignored: " + JSON.stringify(path),
    async () => {
      let workspace = "";
      const commands: GitCommand[] = [];
      const result = await new LocalGitBootstrap({
        token: () => {
          throw new Error("Must not fetch credentials");
        },
        makeTempDirectory: async () => workspace = await Deno.makeTempDir(),
        run: (command) => {
          commands.push(command);
          return fakeGit(command);
        },
        runPostCreateCommand: async ({ cwd }) => {
          await Deno.writeTextFile(join(cwd, ".gitignore"), "*\n");
          if (path === "link" || path === ".git") {
            await Deno.symlink(workspace, join(cwd, path));
          } else {
            const parts = path.split("/");
            if (parts.length > 1) {
              await Deno.mkdir(join(cwd, ...parts.slice(0, -1)), {
                recursive: true,
              });
            }
            await Deno.writeTextFile(join(cwd, path), "unsafe");
            if (path === "case.txt") {
              await Deno.writeTextFile(join(cwd, "CASE.txt"), "collision");
            }
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      }).bootstrap({
        ...request,
        postCreateCommands: [{ command: "fake" }],
      });
      assertEquals(result.failure, "invalid_files", JSON.stringify(result));
      assertEquals(result.pushAttempted, false);
      assert(
        !commands.some(({ args }) =>
          ["hash-object", "update-index", "commit-tree"].includes(args[0])
        ),
      );
      await assertRejects(() => Deno.stat(workspace), Deno.errors.NotFound);
    },
  );
}
