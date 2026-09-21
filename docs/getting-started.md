# Getting started

The recommended way to start with OctoSmith is to create a dedicated control
repository and let the scaffolder generate a conservative baseline.

## Create a control repository

```sh
deno create jsr:@octosmith/octosmith@0 github-config -- --organization acme
```

The generated configuration is scoped to the control repository itself. This is
intentional: the first apply should not unexpectedly manage an entire
organization.

Useful options:

```text
--organization <name>
--collection-management <explicit|strict>
--default-branch <name>
--no-workflows
--event-streaming
```

## Validate

Validation is fully offline:

```sh
deno run -A jsr:@octosmith/cli@0 validate --path ./github-config
```

Validation checks the configuration schema, template compatibility, file
sources, and static planner invariants without contacting GitHub.

## Plan

Planning requires GitHub read access:

```sh
GITHUB_TOKEN=... deno run -A jsr:@octosmith/cli@0 plan --path ./github-config
```

Review the plan before applying, especially when strict collection management is
enabled.

## Apply

```sh
GITHUB_TOKEN=... deno run -A jsr:@octosmith/cli@0 apply --path ./github-config
```

Apply reads fresh GitHub state and creates a new plan. It does not replay an
earlier plan.

Apply is not transactional. Earlier operations for a repository may already be
applied when a later operation fails.

## Next steps

- Read [configuration](configuration.md) before widening repository scope.
- Read [automation](automation.md) before adding organization credentials to CI.
- See [architecture](architecture.md) when embedding OctoSmith or extending the
  engine.
