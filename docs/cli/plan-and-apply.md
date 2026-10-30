# Plan and apply

## plan

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration
GITHUB_TOKEN=... octosmith plan --path ./configuration --quiet
```

`plan` reads GitHub and reports the operations required to reach the desired
state. It does not mutate GitHub. Participating secrets must have runtime
sources available; their values are never included in the plan or report.

Use `--template <template>` to limit planning to repositories classified with a
template. The value may be a template name or its canonical identity:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --template repository:libraries
```

An existing template with no matching repositories produces an empty successful
report. A template filter cannot be combined with a positional repository
target.

Use `--quiet` to suppress the normal planning report. It can be combined with
`--out` to write a persisted plan without printing the report:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --out plan.json --quiet
```

Planning failures remain visible on stderr; a failed persisted plan is not
written.

Unmatched repositories include the effective policy and its consequence. The
summary reports repository statuses, operation outcomes, and skipped runtime
bindings separately. Operation counts come from apply-item outcomes. A skipped
operation is a planned change that was not executed after another resource
failed during preparation; unchanged items are not counted. Skipped runtime
bindings count distinct template bindings excluded by `--skip-missing-values`;
these values are not interchangeable:

```text
Unmatched repositories (3):
  Policy: ignore
  These repositories are excluded from reconciliation.

  - legacy-service
  - archived-service
  - docs-site

Warnings:
  Skipped runtime values:
    SLACK_BOT_OPERATION_TOKEN (secret) — 21 repositories
    COPILOT_REVIEW_TOKEN (secret) — 21 repositories

  42 bindings excluded from reconciliation.
  Existing destination values will not be modified or deleted.

Summary:
  Repositories: 21 planned, 0 unchanged, 0 applied, 0 partially-applied, 0 failed, 0 fallback, 3 unmatched
  Operations:   87 planned, 0 applied, 0 failed, 0 skipped
  Exclusions:   42 skipped runtime bindings
```

Fresh plan/apply JSON reports include an `inspection` object with the same
`resources` and `summary` shape as `resource list`. Classification is
independent of execution outcomes: under the default policy an unmatched
resource also has a failed execution report; under `ignore` it has no execution
report but remains visible in inspection. Fallback-selected repositories have
normal execution reports and persisted operations under the fallback template.
Ignored resources do not generate execution events or persisted operations.
Applying a persisted plan reports only its stored resource set, without a new
scope-wide inspection.

Use `--out <file>` to persist the exact executable operations:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --out plan.json
```

The persisted artifact is distinct from `--format json` output. It may contain
resolved variables and managed-file contents, but never resolved secret values.

All new persisted artifacts use version 2, even when secrets are included or no
resources are selected. Version 2 adds optional resource-level
`secretsExcluded: true`; omission means secrets were not excluded by policy.
Version 1 is the legacy format and does not accept that property. Octosmith
continues accepting and executing version-1 plans without regeneration,
automatic upgrading, or replanning. Older releases may not read version-2 plans.
The configuration schema version remains 1.

## apply

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration
GITHUB_TOKEN=... octosmith apply --path ./configuration --quiet
```

`apply` reads fresh GitHub state, builds a new plan, and applies that plan by
default.

Use `--quiet` to suppress the normal report. Errors remain on stderr and the
exit code is unchanged.

Use `--template <template>` to apply only repositories classified with that
template:

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration --template repository:libraries
```

Use `--plan <file>` to execute a persisted plan:

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration --plan plan.json
```

Template-scoped plans can be persisted and later applied without repeating the
template filter:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --template repository:libraries --out libraries.plan.json
GITHUB_TOKEN=... octosmith apply --path ./configuration --plan libraries.plan.json
```

Persisted apply verifies root configuration, effective resource templates, and
template-owned remote state before the first mutation. A stale preflight reports
each resource as `valid`, `template`, or `state` and applies nothing. Resource
state is checked again immediately before mutation. Stored operations are
executed exactly and are never rebuilt.

PR-mode artifacts also contain the complete desired managed files and target
commit snapshot, but never PR numbers, URLs, or lifecycle commands. Target
advancement or missing snapshots require a new plan. An empty operation list
still runs apply-time PR reconciliation and can close an obsolete PR. Direct
delivery retains its existing managed-path concurrency semantics.

Apply is not transactional. If one operation fails, earlier operations for that
repository may already have been applied. Remaining operations for that
repository are skipped, and Octosmith stops before mutating later repositories.

## Secret opt-in

Both `plan` and fresh `apply` accept an optional boolean:

```sh
octosmith plan --include-secrets
octosmith plan --include-secrets=true
octosmith plan --include-secrets=false
octosmith apply --include-secrets
octosmith apply --include-secrets=true
octosmith apply --include-secrets=false
```

The default configured mode is `automatic`, which includes secrets in every
fresh run. With `repositories.settings.secrets: manual`, only the bare flag or
explicit `true` opts secrets in. Explicit `false` respects the configured mode;
it does not force secrets off. Invalid explicit values such as `yes`, `1`, or
`maybe` fail argument parsing.

Manual exclusion covers Actions, Dependabot, and environment secrets, preserves
remote secrets even under strict management, and requires no secret inputs.
Variables and other resources continue reconciling. Text and JSON reports
explain policy exclusion without enumerating secret names. The independent
`--skip-missing-values` flag still governs missing participating inputs.

With `apply --plan`, all three flag forms are accepted but ignored. Saved
operations and exclusions are authoritative, even after the configured mode
changes. Mode-only changes leave configuration hashes valid; real configuration,
template, state, and replay dependency changes remain checked.

## Target one resource

`plan` and `apply` accept an optional resource target immediately after the
command:

```sh
octosmith plan api-service --path ./configuration
octosmith apply api-service --path ./configuration
```

The target narrows the configured scope; it does not override it. Today the only
supported top-level resource target is a repository, so a resource outside
`repositories.scope` is rejected and never mutated.
