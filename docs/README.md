# Octosmith documentation

Start with [getting started](getting-started.md) to create a control repository,
validate its configuration, and run plan/apply.

## User guides

- [Root configuration file](root-configuration.md) — `octosmith.yml`, scope,
  organization policies, fallback selection, and file-delivery options.
- [Repository template file](repository-template.md) — schema-driven desired
  state fields, fragment composition, and fallback template behavior.
- [Configuration behavior](configuration.md) — runtime values, secrets,
  bootstrap, branch settings, and managed file reconciliation.
- [CLI command reference](cli/README.md) — navigate commands by workflow.
- [Automation](automation.md) — GitHub Action, credentials, generated workflows,
  and event streaming.
- [Library API](library/programmatic-api.md) — TypeScript usage and exposed
  APIs.
- [Library configuration examples](library/configuration-model.md) — model
  examples.
- [Repository creation lifecycle](library/repository-creation.md) — reusable
  library API for creating repositories.

## Maintainer reference

- [Architecture](architecture.md) — system boundaries, planning, GitHub
  integration, state ownership, and persisted plans.
- [Agent guide](agent-guide.md) — repository conventions and CI expectations.
- [Managed-file reconciliation investigation](managed-file-reconciliation.md) —
  historical diagnosis and recovery findings, not a configuration reference.

The root and package READMEs are entry points, not exhaustive references.
Module-level JSDoc documents the public JSR entry points; declaration JSDoc
provides API reference content.
