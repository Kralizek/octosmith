import { assertEquals } from "@std/assert";
import {
  FetchGitHubClient,
  resolveRepositoryOwner,
} from "@octosmith/octosmith";
import { main } from "../../packages/cli/mod.ts";

const enabled = Deno.env.get("OCTOSMITH_PERSONAL_OWNER_E2E") === "1";

Deno.test({
  name: "opt-in personal owner CLI creation, bootstrap, plan, and apply",
  ignore: !enabled,
  fn: async () => {
    const configuredOwner = Deno.env.get("OCTOSMITH_PERSONAL_OWNER");
    const token = Deno.env.get("GITHUB_TOKEN");
    if (!configuredOwner || !token) {
      throw new Error(
        "Set OCTOSMITH_PERSONAL_OWNER and GITHUB_TOKEN for the opt-in personal-owner E2E test.",
      );
    }

    const client = new FetchGitHubClient({ token });
    const owner = await resolveRepositoryOwner(client, configuredOwner);
    if (owner.type !== "User") {
      throw new Error(
        "OCTOSMITH_PERSONAL_OWNER must identify the authenticated personal account.",
      );
    }

    const name = "octosmith-personal-e2e-" +
      crypto.randomUUID().slice(0, 8);
    const root = await Deno.makeTempDir();
    let created = false;
    try {
      await Deno.mkdir(root + "/templates");
      await Deno.writeTextFile(
        root + "/octosmith.yml",
        [
          "version: 1",
          `organization: ${owner.login}`,
          "repositories:",
          "  scope:",
          "    include:",
          `      names: ["${name}"]`,
          "      visibility: private",
          "",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        root + "/templates/e2e.yml",
        [
          "version: 1",
          "kind: repository",
          "match:",
          "  include: all",
          "repository:",
          "  settings:",
          '    description: "Octosmith disposable personal-owner E2E"',
          "",
        ].join("\n"),
      );

      const run = async (args: readonly string[]) => {
        const output: string[] = [];
        const errors: string[] = [];
        const code = await main([...args, "--path", root, "--format", "json"], {
          credentials: { getEnv: () => token },
          write: (value) => output.push(value),
          writeError: (value) => errors.push(value),
        });
        if (code !== 0) {
          throw new Error(
            `CLI ${args.join(" ")} failed (${code}): ${
              output.join("\n") || errors.join("\n")
            }`,
          );
        }
        return JSON.parse(output.join("\n")) as Record<string, unknown>;
      };

      const creation = await run([
        "resource",
        "create",
        "e2e",
        "--name",
        name,
        "--visibility",
        "private",
      ]);
      const createdRepository = creation.repository as
        | { readonly fullName?: string }
        | undefined;
      created = createdRepository?.fullName?.toLowerCase() ===
        `${owner.login}/${name}`.toLowerCase();
      assertEquals(creation.status, "completed");
      assertEquals(creation.owner, owner.login);
      assertEquals(creation.ownerType, "User");
      assertEquals(created, true);

      const plan = await run(["plan"]);
      const plannedRepositories = (plan.repositories as readonly {
        readonly repository: string;
        readonly status: string;
      }[]).map(({ repository, status }) => ({ repository, status }));
      assertEquals(plannedRepositories, [{
        repository: name,
        status: "unchanged",
      }]);

      const applied = await run(["apply"]);
      const appliedRepositories = (applied.repositories as readonly {
        readonly repository: string;
        readonly status: string;
      }[]).map(({ repository, status }) => ({ repository, status }));
      assertEquals(appliedRepositories, [{
        repository: name,
        status: "unchanged",
      }]);
    } finally {
      if (created) {
        await client.request(
          "DELETE",
          "/repos/" + encodeURIComponent(owner.login) + "/" +
            encodeURIComponent(name),
        );
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});
