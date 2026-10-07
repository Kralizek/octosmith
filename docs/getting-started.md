# Getting started

The recommended way to start with Octosmith is to create a dedicated control
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
deno run -A jsr:@octosmith/cli@0 template validate --path ./github-config
```

Validation checks the configuration schema, template compatibility, file
sources, and static planner invariants without contacting GitHub.

## Plan

Planning requires GitHub read access:

```powershell
gh auth login
octosmith plan --path ./github-config
```

Or set `GITHUB_TOKEN` (which takes precedence over GitHub CLI credentials):

```powershell
$env:GITHUB_TOKEN = "..."
octosmith plan --path ./github-config
```

The Deno CLI can also be run directly with an environment token:

```sh
GITHUB_TOKEN=... deno run -A jsr:@octosmith/cli@0 plan --path ./github-config
```

Review the plan before applying, especially when strict collection management is
enabled.

When planning or applying configuration directly without orchestration-provided
values, pass `--skip-missing-values` to exclude unavailable values and receive a
warning instead of failing. This covers Actions variables and secrets,
Dependabot secrets, and environment variables and secrets. Skipped values are
never written or deleted, even with strict collection management. Available
values, including explicitly empty values, are still reconciled normally.
Configuration errors and unrelated runtime-provider failures still fail.

To persist the exact reviewed operations:

```sh
GITHUB_TOKEN=... deno run -A jsr:@octosmith/cli@0 plan \
  --path ./github-config \
  --out plan.json
```

The artifact contains resolved non-secret operation values, but never resolved
secret values. Treat it as potentially sensitive configuration data.

## Apply

```sh
GITHUB_TOKEN=... deno run -A jsr:@octosmith/cli@0 apply --path ./github-config
```

Without `--plan`, apply reads fresh GitHub state and creates a new plan.

To execute a persisted plan exactly as reviewed:

```sh
GITHUB_TOKEN=... deno run -A jsr:@octosmith/cli@0 apply \
  --path ./github-config \
  --plan plan.json
```

Persisted apply verifies the root configuration, the effective template for each
resource, and the remote state owned by that template before making any
mutation. If preflight finds drift, no changes are applied and the resource
summary reports `valid`, `template`, or `state`.

Each resource state precondition is checked again immediately before that
resource is mutated. Persisted operations are never rebuilt or silently
replanned.

Exclusions made with `plan --skip-missing-values --out plan.json` are saved in
the artifact and honored automatically by `apply --plan plan.json`, with the
same warnings. Those values remain excluded even if their runtime sources later
become available. Changes to skipped remote values do not make the plan stale;
changes to other managed values still do.

`--skip-missing-values` cannot be combined with `--plan`: applying an artifact
must not drop approved operations. Secrets required by saved operations must
still be available. Create a new plan with the flag to change its exclusions.

Apply is not transactional. Earlier operations for a repository may already be
applied when a later operation fails.

## Next steps

- Read [configuration](configuration.md) before widening repository scope.
- Read [automation](automation.md) before adding organization credentials to CI.
- See [architecture](architecture.md) when embedding Octosmith or extending the
  engine.
