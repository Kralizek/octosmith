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
      oidc: {
        subjectClaimTemplate: { source: "default" as const },
        immutableSubject: false,
      },
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

  getSecrets(repository: string) {
    this.calls.push("secrets:" + repository);
    return Promise.resolve(["OWNED", "EXTRA"]);
  }

  getVariables(repository: string) {
    this.calls.push("variables:" + repository);
    return Promise.resolve([
      { name: "OWNED", value: "1" },
      { name: "EXTRA", value: "2" },
    ]);
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
    variables: [{ name: "OWNED", value: "1" }],
    files: [
      { path: "exists.txt", ensure: "exact", content: "desired" },
      { path: "missing.txt", ensure: "exists", content: "seed" },
    ],
  });

  assertEquals(state.variables, [{ name: "OWNED", value: "1" }]);
  assertEquals(state.files, [{
    path: "exists.txt",
    content: "current",
    sha: "sha",
  }]);
  assertEquals(source.calls.sort(), [
    "file:sample:exists.txt",
    "file:sample:missing.txt",
    "settings:sample",
    "variables:sample",
  ]);
});

Deno.test("sparse current-state reading keeps only named owned members", async () => {
  const source = new FakeStateSource();
  const state = await readCurrentState(source, fullDesired());

  assertEquals(state.customProperties, { keep: "yes" });
  assertEquals(state.teams.map((item) => item.team), ["owned"]);
  assertEquals(state.secrets, ["OWNED"]);
  assertEquals(state.variables.map((item) => item.name), ["OWNED"]);
  assertEquals(state.rulesets.map((item) => item.name), ["owned"]);
  assertEquals(state.environments, [{
    name: "owned",
    secrets: ["OWNED_SECRET"],
    variables: [{ name: "OWNED_VARIABLE", value: "1" }],
  }]);
});

Deno.test("sparse current-state reading preserves members for explicit clears", async () => {
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
  const state = await readCurrentState(
    source,
    fullDesired(),
    { collections: "strict" },
  );

  assertEquals(state.customProperties, {
    keep: "yes",
    extra: "preserve-only-in-strict",
  });
  assertEquals(state.teams.map((item) => item.team), ["owned", "extra"]);
  assertEquals(state.secrets, ["OWNED", "EXTRA"]);
  assertEquals(state.variables.map((item) => item.name), ["OWNED", "EXTRA"]);
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
    actions: { enabled: true },
    teams: [{
      team: "owned",
      permission: { kind: "built-in", name: "pull" },
    }],
    secrets: ["OWNED"],
    variables: [{ name: "OWNED", value: "1" }],
    rulesets: [{ name: "owned" }],
    environments: [{
      name: "owned",
      secrets: ["OWNED_SECRET"],
      variables: [{ name: "OWNED_VARIABLE", value: "1" }],
    }],
  };
}
