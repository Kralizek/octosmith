# Octosmith

Declarative desired-state management for GitHub repositories.

Octosmith discovers repositories in a GitHub organization, matches them to
configuration templates, and validates, plans, or applies their desired state.
Use the CLI locally or run it through GitHub Actions.

## Get started

Create a control repository:

```sh
deno create jsr:@octosmith/octosmith@0 github-config -- --organization acme
```

Edit `octosmith.yml` and the generated templates, then inspect and apply:

```sh
deno install -A -n octosmith jsr:@octosmith/cli@0
octosmith template validate --path ./github-config
octosmith resource list --path ./github-config
octosmith plan --path ./github-config
octosmith apply --path ./github-config
```

Validation runs offline; inspection, planning, and application require GitHub
access. Review the plan before applying changes, especially when managing
collections, secrets, or repository files.

For setup, permissions, credentials, and workflows, follow the
[getting-started guide](docs/getting-started.md).

## Documentation

- [Documentation index](docs/README.md) — guides, CLI reference, and library
  API.
- [Root configuration](docs/root-configuration.md) — scope and policies.
- [Repository templates](docs/repository-template.md) — desired state and
  fragment composition, including create-only bootstrap commands.
- [Configuration behavior](docs/configuration.md) — secrets and file delivery.
- [CLI reference](docs/cli/README.md) — all commands and their options.
- [Automation](docs/automation.md) — GitHub Action and workflow integration.
- [Architecture](docs/architecture.md) — engine design and lifecycle.

An [example configuration](examples/configuration) covers repository selection,
settings, rulesets, environments, teams, and managed files.

## Packages

| Package                                                | Use for                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| [`@octosmith/cli`](packages/cli/README.md)             | Interactive and automated CLI commands                        |
| [`@octosmith/octosmith`](packages/octosmith/README.md) | TypeScript models, planning, GitHub adapters, and scaffolding |

The repository also ships a [GitHub Action](docs/automation.md#github-action)
with `validate`, `plan`, and `apply` modes.

Octosmith is on the 0.x release line; its public APIs and configuration may
change before 1.0.
