# @octosmith/cli

Command-line interface for OctoSmith.

OctoSmith reconciles GitHub repositories against declarative configuration. It
loads a configuration directory, discovers repositories in scope, resolves each
repository to exactly one template, compares desired and current state, and
either reports or applies the resulting operations.

## Requirements

Set `GITHUB_TOKEN` to a token with the GitHub permissions required by the
configuration being reconciled.

Runtime values for Actions variables, Actions secrets, Dependabot secrets, and
environment values can be read from process environment variables. Variables can
also declare literal values in configuration. Secret values are never stored in
OctoSmith configuration.

## Configuration directory

A configuration directory contains `octosmith.yml`, repository templates, and
optionally source files managed by those templates.

```text
configuration/
├── octosmith.yml
├── templates/
│   └── dotnet-library.yml
└── files/
    └── ...
```

The root configuration selects the GitHub organization and repository scope and
defines repository-management behavior:

```yaml
version: 1
organization: acme

repositories:
  scope:
    names:
      - "*"

  settings:
    collection_management: explicit
```

Repository templates explicitly declare their kind. `match` selects
repositories; `repository` contains the desired state for repositories that
match:

```yaml
kind: repository

match:
  names:
    - "library-*"

repository:
  settings:
    has_issues: true

  teams:
    - name: maintainers
      permission: maintain

  rulesets: []
  environments: []
  files: {}
```

Configuration and all templates are schema-validated before repository
discovery. Unknown keys, unsupported configuration versions, missing template
kinds, unsupported kinds, and empty selectors are rejected.

## Commands

### Plan

```sh
octosmith plan --path ./configuration
```

`plan` reads GitHub state and reports the operations required to reach the
configured desired state. It does not mutate GitHub.

Review the plan before applying, especially when strict collection management is
enabled.

### Apply

```sh
octosmith apply --path ./configuration
```

`apply` reads fresh GitHub state, builds a new plan, and applies that plan. It
does not execute a previously displayed plan.

Apply is not transactional. If an operation fails, earlier operations for that
repository can already have been applied. Remaining operations for the failed
repository are skipped, while reconciliation can continue with other
repositories.

## Output formats

Text output is the default:

```sh
octosmith plan --format text --path ./configuration
```

Use JSON for machine-readable output:

```sh
octosmith plan --format json --path ./configuration
octosmith apply --format json --path ./configuration
```

JSON serializes the complete structured report, including ISO 8601 timestamps,
and preserves the same sensitive-data guarantees as text output. Reconciliation
items are flat objects with `type`, `status`, `details`, and optional `error`.
Targeted and full-scope executions use the same report shape.

Text output uses one line per reconciliation item. Status icons have stable
meanings: `→` planned, `✓` reconciled, `-` already desired, `✗` failed, and `·`
skipped. Repository rows are always shown; unchanged items are hidden by
default. Pass `--verbose` to include unchanged items in text output. JSON always
contains the complete item set.

Verbose mode also traces each GitHub API response to stderr as
`METHOD /endpoint — status`. Traces never include request or response bodies,
headers, query parameters, or credentials. The final report is written only to
stdout, so JSON output remains directly parseable even when verbose tracing is
enabled.

## Target one repository

Both commands accept an optional repository name immediately after the command,
before any options:

```sh
octosmith plan my-repo --path ./configuration
octosmith apply my-repo --path ./configuration
```

The argument narrows the configured repository scope; it never overrides it.
OctoSmith fetches the repository directly, verifies that it belongs to
`repositories.scope`, and then runs the normal reconciliation flow.

A targeted repository outside the configured scope is reported as failed and is
never mutated.

## Repository collection management

`repositories.settings.collection_management` controls how declared collections
are interpreted.

### `explicit` — default

Only explicitly declared members are managed. Undeclared members are preserved.

```yaml
repositories:
  scope:
    names: ["*"]
  settings:
    collection_management: explicit
```

This is the safe default.

An explicitly empty collection can still mean "manage this collection as empty"
where the resource semantics define that behavior. For example, empty
environment variable or secret lists clear those members.

### `strict`

Managed named collections are authoritative. Undeclared members can therefore be
removed.

```yaml
repositories:
  scope:
    names: ["*"]
  settings:
    collection_management: strict
```

Use strict mode only when the configuration is intended to own the complete
collection.

Managed files are an exception: strict collection management never infers file
deletion. Files are deleted only when explicitly configured with
`ensure: absent`.

## Secrets and runtime values

Variables support three forms:

```yaml
variables:
  - VARIABLE_NAME
  - from: EXTERNAL_VARIABLE_NAME
    to: IMPORTED_VARIABLE_NAME
  - name: VARIABLE_NAME
    value: "some value"
```

A bare name reads the process environment variable with the same name. `from`
and `to` read one environment variable and publish it to GitHub under another
name. The `name` / `value` form configures a literal variable value.

Secrets support the same bare-name and rename forms, but never a literal value:

```yaml
secrets:
  - SECRET_NAME
  - from: EXTERNAL_SECRET_NAME
    to: IMPORTED_SECRET_NAME
```

These forms apply consistently to Actions values, Dependabot secrets, and
environment values. Actions and Dependabot secrets remain separate GitHub secret
stores even when they share the same runtime source.

Secret values are resolved and snapshotted before any mutation for that
repository. If a required secret value is missing, no operation for that
repository is applied, including destructive operations.

Plan mode does not require secret values.

GitHub does not expose current secret values, so declared secrets are written on
each apply.

## Reporting and sensitive data

Reports identify affected repositories, resources, settings, and file paths, but
they do not expose:

- secret values
- runtime variable values
- managed file contents

Repository failures are isolated in the report so other repositories can still
be processed where possible.

## Exit codes

OctoSmith returns exit code `0` when the command completes without failed or
partially applied repositories.

It returns exit code `1` for validation failures, reconciliation failures, and
partially applied repositories.
