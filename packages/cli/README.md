# @octosmith/cli

Command-line interface for OctoSmith.

The CLI validates configuration, compares desired state with GitHub, applies
changes, renders reports, and can emit per-repository resource events.

For the configuration format and desired-state model, see
[`@octosmith/octosmith`](../octosmith/README.md).

## Install

```sh
deno install -A -n octosmith jsr:@octosmith/cli@0
```

You can also run it directly with Deno:

```sh
deno run -A jsr:@octosmith/cli@0 --help
```

## Commands

| Command    | GitHub access | Mutates GitHub | Purpose                                              |
| ---------- | ------------- | -------------- | ---------------------------------------------------- |
| `validate` | No            | No             | Validate configuration and static planner invariants |
| `plan`     | Yes           | No             | Compare current GitHub state with desired state      |
| `apply`    | Yes           | Yes            | Build a fresh plan and apply its operations          |

### validate

```sh
octosmith validate --path ./configuration
```

Validation is offline and does not require `GITHUB_TOKEN`.

### plan

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration
```

`plan` reads GitHub and reports the operations required to reach the desired
state. It does not mutate GitHub and does not require secret runtime values.

### apply

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration
```

`apply` reads fresh GitHub state, builds a new plan, and applies that plan. It
never replays a previously displayed plan.

Apply is not transactional. If one operation fails, earlier operations for that
repository may already have been applied. Remaining operations for that
repository are skipped, while other repositories can continue.

## Target one repository

`plan` and `apply` accept an optional repository name immediately after the
command:

```sh
octosmith plan api-service --path ./configuration
octosmith apply api-service --path ./configuration
```

The target narrows the configured scope; it does not override it. A repository
outside `repositories.scope` is rejected and never mutated.

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

`--verbose` also writes GitHub API trace lines to stderr. Traces contain the
HTTP method, endpoint path, and status only; they do not include bodies,
headers, query parameters, or credentials. The final report remains on stdout.

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
- `1` for validation errors, command errors, failed repositories, or partially
  applied repositories

## Common options

```text
--path <path>            Configuration directory (default: .)
--format <text|json>     Output format (default: text)
--verbose                Include unchanged text items and GitHub API traces
--events-output <path>   Write repository events as NDJSON
```

`--verbose` and `--events-output` apply to `plan` and `apply`. `validate`
supports `--path` and `--format`.
