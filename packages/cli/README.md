# @octosmith/cli

Command-line interface for Octosmith.

The CLI validates configuration, compares desired state with GitHub, applies
changes, renders reports, and can emit per-repository resource events.

For the configuration format and desired-state model, see
[`@octosmith/octosmith`](../octosmith/README.md).

For GitHub Actions, generated workflows, credentials, and event streaming, see
the repository [automation guide](../../docs/automation.md).

## Install

```sh
deno install -A -n octosmith jsr:@octosmith/cli@0
```

You can also run it directly with Deno:

```sh
deno run -A jsr:@octosmith/cli@0 --help
```

## Commands

| Command             | GitHub access | Mutates GitHub | Purpose                                              |
| ------------------- | ------------- | -------------- | ---------------------------------------------------- |
| `template validate` | No            | No             | Validate configuration and static planner invariants |
| `plan`              | Yes           | No             | Compare current GitHub state with desired state      |
| `apply`             | Yes           | Yes            | Build a fresh plan and apply its operations          |

### template validate

```sh
octosmith template validate --path ./configuration
```

Validation is offline and does not require `GITHUB_TOKEN`.

### plan

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration
```

`plan` reads GitHub and reports the operations required to reach the desired
state. It does not mutate GitHub and does not require secret runtime values.

Use `--out <file>` to persist the exact executable operations:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --out plan.json
```

The persisted artifact is distinct from `--format json` output. It may contain
resolved variables and managed-file contents, but never resolved secret values.

### apply

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration
```

`apply` reads fresh GitHub state, builds a new plan, and applies that plan by
default.

Use `--plan <file>` to execute a persisted plan:

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration --plan plan.json
```

Persisted apply verifies root configuration, effective resource templates, and
template-owned remote state before the first mutation. A stale preflight reports
each resource as `valid`, `template`, or `state` and applies nothing. Resource
state is checked again immediately before mutation. Stored operations are
executed exactly and are never rebuilt.

Apply is not transactional. If one operation fails, earlier operations for that
repository may already have been applied. Remaining operations for that
repository are skipped, and Octosmith stops before mutating later repositories.

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

## Authentication

`plan` and `apply` read the GitHub credential from `GITHUB_TOKEN`.

The token needs read permissions for every resource used by planning, plus the
corresponding write permissions for resources managed by apply. For
organization-wide automation this is commonly a fine-grained personal access
token or a GitHub App installation token.

Credentials are never added to CLI arguments or reports.

## Output

Text is the default:

```sh
octosmith plan --format text --path ./configuration
```

Use JSON for automation:

```sh
octosmith plan --format json --path ./configuration
octosmith apply --format json --path ./configuration
```

JSON contains the full structured report. Text hides unchanged items unless
`--verbose` is supplied.

Use `--trace` to write GitHub API trace lines to stderr. Traces contain the HTTP
method, endpoint path, and status only; they do not include bodies, headers,
query parameters, or credentials. The final report remains on stdout.

## Resource events

`plan` and `apply` can write one NDJSON event per processed repository:

```sh
octosmith apply \
  --events-output ./octosmith-events.ndjson \
  --path ./configuration
```

The destination is any writable path supported by the host, including a regular
file or FIFO.

- `plan` emits `resource.planned`
- `apply` emits `resource.applied`

Events are emitted as each repository finishes. The normal report still goes to
stdout and diagnostics remain on stderr.

Failure to open or write an explicitly requested event output fails the command
rather than silently dropping events.

## Exit codes

The CLI returns:

- `0` when validation succeeds or plan/apply completes without failed or
  partially applied repositories
- `1` for validation errors, usage errors, command errors, failed repositories,
  or partially applied repositories

## Common options

```text
--path <path>            Configuration directory (default: .)
--format <text|json>     Output format (default: text)
-v, --verbose            Include unchanged text items in reports
--trace                  Emit GitHub API traces to stderr
--events-output <path>   Write resource events as NDJSON
```

`--verbose`, `--trace`, and `--events-output` apply to `plan` and `apply`.
`resource list`, `resource create`, `template validate`, and
`template permissions` support `--path` and `--format`.

## Grouped commands

The canonical grouped command surface is:

```text
octosmith resource list
octosmith resource create <template>
octosmith template validate [template]
octosmith template permissions [template]
```
