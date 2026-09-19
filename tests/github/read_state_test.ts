import { assertEquals } from "@std/assert";
import type { CurrentRepositorySettings, DesiredState } from "@octosmith/core";
import {
  readCurrentState,
  type RepositoryStateSource,
} from "@octosmith/github";
import { currentRepositorySettings } from "../plan/fixtures.ts";

class FakeStateSource implements RepositoryStateSource {
  readonly calls: string[] = [];

  getRepositorySettings(repository: string) {
    this.calls.push("settings:" + repository);
    return Promise.resolve(currentRepositorySettings());
  }

  getCustomProperties(repository: string) {
    this.calls.push("properties:" + repository);
    return Promise.resolve({
      keep: "yes",
      extra: "preserve-only-in-strict",
    });
  }

  getActionsSettings(repository: string) {
    this.calls.push("actions:" + repository);
    return Promise.resolve({
      enabled: true,
      allowedActions: "all" as const,
      shaPinningRequired: false,
    });
  }

  getActionsOidcSettings(repository: string) {
    this.calls.push("actions-oidc:" + repository);
    return Promise.resolve({
      subjectClaimTemplate: { source: "organization" as const },
      immutableSubject: true,
    });
  }

  getTeams(repository: string) {
    this.calls.push("teams:" + repository);
    return Promise.resolve([
      {
        team: "owned",
        permission: { kind: "built-in" as const, name: "pull" as const },
      },
      {
        team: "extra",
        permission: { kind: "built-in" as const, name: "push" as const },
      },
    ]);
  }

  getActionsSecrets(repository: string) {
    this.calls.push("actions-secrets:" + repository);
    return Promise.resolve(["OWNED", "EXTRA"]);
  }

  getActionsVariables(repository: string) {
    this.calls.push("actions-variables:" + repository);
    return Promise.resolve([
      { name: "OWNED", value: "1" },
      { name: "EXTRA", value: "2" },
    ]);
  }

  getDependabotSecrets(repository: string) {
    this.calls.push("dependabot-secrets:" + repository);
    return Promise.resolve(["OWNED_DEPENDABOT", "EXTRA_DEPENDABOT"]);
  }

  getRulesets(repository: string) {
    this.calls.push("rulesets:" + repository);
    return Promise.resolve([
      {
        id: 1,
        name: "owned",
        target: "push" as const,
        enforcement: "active" as const,
        bypassActors: [],
        rules: [],
      },
      {
        id: 2,
        name: "extra",
        target: "push" as const,
        enforcement: "active" as const,
        bypassActors: [],
        rules: [],
      },
    ]);
  }

  getEnvironments(repository: string) {
    this.calls.push("environments:" + repository);
    return Promise.resolve([
      {
        name: "owned",
        secrets: ["OWNED_SECRET", "EXTRA_SECRET"],
        variables: [
          { name: "OWNED_VARIABLE", value: "1" },
          { name: "EXTRA_VARIABLE", value: "2" },
        ],
      },
      { name: "extra", secrets: [], variables: [] },
    ]);
  }

  getFile(repository: string, path: string) {
    this.calls.push("file:" + repository + ":" + path);

    return Promise.resolve(
      path === "exists.txt"
        ? { path, content: "current", sha: "sha" }
        : undefined,
    );
  }
}

Deno.test("current-state reader fetches only desired resource families", async () => {
  const source = new FakeStateSource();

  const state = await readCurrentState(source, {
    repository: "sample",
    template: "code",
    settings: { hasIssues: true },
    actions: { variables: [{ name: "OWNED", value: "1" }] },
    files: [
      { path: "exists.txt", ensure: "exact", content: "desired" },
      { path: "missing.txt", ensure: "exists", content: "seed" },
    ],
  });

  assertEquals(state.actions.variables, [{ name: "OWNED", value: "1" }]);
  assertEquals(state.files, [{
    path: "exists.txt",
    content: "current",
    sha: "sha",
  }]);
  assertEquals(source.calls.sort(), [
    "actions-variables:sample",
    "file:sample:exists.txt",
    "file:sample:missing.txt",
    "settings:sample",
  ]);
});

Deno.test("OIDC-only ownership reads only the OIDC endpoint family", async () => {
  const source = new FakeStateSource();

  const state = await readCurrentState(source, {
    repository: "sample",
    template: "code",
    actions: {
      oidc: {
        subjectClaimTemplate: { source: "organization" },
      },
    },
  });

  assertEquals(state.actions.oidc, {
    subjectClaimTemplate: { source: "organization" },
    immutableSubject: true,
  });
  assertEquals(source.calls.sort(), [
    "actions-oidc:sample",
    "settings:sample",
  ]);
});

Deno.test("explicit current-state reading keeps only named owned members", async () => {
  const source = new FakeStateSource();
  const state = await readCurrentState(source, fullDesired());

  assertEquals(state.customProperties, { keep: "yes" });
  assertEquals(state.teams.map((item) => item.team), ["owned"]);
  assertEquals(state.actions.secrets, ["OWNED"]);
  assertEquals(state.actions.variables.map((item) => item.name), ["OWNED"]);
  assertEquals(state.rulesets.map((item) => item.name), ["owned"]);
  assertEquals(state.environments, [{
    name: "owned",
    secrets: ["OWNED_SECRET"],
    variables: [{ name: "OWNED_VARIABLE", value: "1" }],
  }]);
});

Deno.test("explicit current-state reading preserves members for explicit clears", async () => {
  const source = new FakeStateSource();
  const state = await readCurrentState(source, {
    repository: "sample",
    template: "code",
    environments: [{
      name: "owned",
      secrets: [],
      variables: [],
    }],
  });

  assertEquals(state.environments, [{
    name: "owned",
    secrets: ["OWNED_SECRET", "EXTRA_SECRET"],
    variables: [
      { name: "OWNED_VARIABLE", value: "1" },
      { name: "EXTRA_VARIABLE", value: "2" },
    ],
  }]);
});

Deno.test("strict current-state reading preserves complete named collections", async () => {
  const source = new FakeStateSource();
  const state = await readCurrentState(source, {
    ...fullDesired(),
    collections: "strict",
  });

  assertEquals(state.customProperties, {
    keep: "yes",
    extra: "preserve-only-in-strict",
  });
  assertEquals(state.teams.map((item) => item.team), ["owned", "extra"]);
  assertEquals(state.actions.secrets, ["OWNED", "EXTRA"]);
  assertEquals(
    state.actions.variables.map((item) => item.name),
    ["OWNED", "EXTRA"],
  );
  assertEquals(
    state.dependabot.secrets,
    ["OWNED_DEPENDABOT", "EXTRA_DEPENDABOT"],
  );
  assertEquals(state.rulesets.map((item) => item.name), ["owned", "extra"]);
  assertEquals(
    state.environments.map((item) => item.name),
    ["owned", "extra"],
  );
});

Deno.test("repository settings are always loaded", async () => {
  const source = new FakeStateSource();
  const state = await readCurrentState(source, {
    repository: "sample",
    template: "code",
  });

  assertEquals(
    state.settings as CurrentRepositorySettings,
    currentRepositorySettings(),
  );
  assertEquals(source.calls, ["settings:sample"]);
});

function fullDesired(): DesiredState {
  return {
    repository: "sample",
    template: "code",
    customProperties: { keep: "yes" },
    actions: {
      enabled: true,
      secrets: [{ name: "OWNED", source: "OWNED_SOURCE" }],
      variables: [{ name: "OWNED", value: "1" }],
    },
    dependabot: {
      secrets: [{ name: "OWNED_DEPENDABOT", source: "DEPENDABOT_SOURCE" }],
    },
    teams: [{
      team: "owned",
      permission: { kind: "built-in", name: "pull" },
    }],
    rulesets: [{ name: "owned" }],
    environments: [{
      name: "owned",
      secrets: [{ name: "OWNED_SECRET", source: "ENV_SECRET_SOURCE" }],
      variables: [{ name: "OWNED_VARIABLE", value: "1" }],
    }],
  };
}
