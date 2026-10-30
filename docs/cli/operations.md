# CLI operations and output

## Authentication

For local use, sign in with GitHub CLI and run Octosmith:

```powershell
gh auth login
octosmith plan
```

Alternatively, supply a token yourself:

```powershell
$env:GITHUB_TOKEN = "..."
octosmith plan
```

`resource list`, `plan`, and `apply` use an explicitly injected runtime/token
first, then `GITHUB_TOKEN`, then `gh auth token` for local use. An environment
token takes precedence over GitHub CLI credentials. The CLI requests the
`github.com` token, matching Octosmith's GitHub API host. GitHub Actions
continues to use its `github-token` input through `GITHUB_TOKEN` and does not
invoke `gh` when the input is missing. `template validate` and
`template permissions` do not resolve GitHub credentials; validation only checks
environment-backed secret presence as described above.

The token needs read permissions for every resource used by planning, plus the
corresponding write permissions for resources managed by apply. For
organization-wide automation this is commonly a fine-grained personal access
token or a GitHub App installation token.

Credentials are never added to CLI arguments, reports, or diagnostics.

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

JSON contains the full structured report. Apply results include a canonical
`pullRequests` collection, sorted and deduplicated, with successful `opened`,
`updated`, and `closed` outcomes. Closed entries have
`reason: "no_differences"`. No-op PRs and direct file writes contribute no
lifecycle entry. Plan reports never contain actual PR outcomes. Successful
entries survive later failures.

```json
{
  "pullRequests": [
    {
      "repository": "api-service",
      "number": 42,
      "url": "https://github.com/acme/api-service/pull/42",
      "action": "opened"
    },
    {
      "repository": "worker",
      "number": 56,
      "url": "https://github.com/acme/worker/pull/56",
      "action": "closed",
      "reason": "no_differences"
    }
  ]
}
```

Text hides unchanged items and affected-resource lists unless `--verbose` is
supplied. Apply ends with a consolidated section when there are PR outcomes:

```text
Pull requests:
  api-service - acme/api-service#42 https://github.com/acme/api-service/pull/42 - opened
  worker - acme/worker#56 https://github.com/acme/worker/pull/56 - closed (no_differences)
```

`--quiet` suppresses normal stdout for `template validate`, `plan`, and `apply`.
It cannot be combined with `--format json`.

Use `--trace` to write GitHub API trace lines to stderr. Traces contain the HTTP
method, endpoint path, and status only; they do not include bodies, headers,
query parameters, or credentials. The final report remains on stdout.

## Resource events

`plan` and `apply` can write NDJSON repository and PR lifecycle events:

```sh
octosmith apply \
  --events-output ./octosmith-events.ndjson \
  --path ./configuration
```

The destination is any writable path supported by the host, including a regular
file or FIFO.

- `plan` emits `resource.planned`
- `apply` emits `resource.applied`
- apply also emits `pull_request.opened`, `pull_request.updated`, and
  `pull_request.closed` immediately after successful corresponding GitHub
  actions

Repository events are emitted as each repository finishes. PR events use
`source: {kind: "github.organization", id: organization}`,
`subject: {kind: "github.pull_request", id: "repository#number"}`, producer
`octosmith`, and the canonical lifecycle result as `data`. They are not emitted
again when the final report is rendered. The normal report still goes to stdout
and diagnostics remain on stderr.

Failure to open or write an explicitly requested event output fails the command
rather than silently dropping events.

## Exit codes

The CLI returns:

- `0` when validation succeeds or plan/apply completes without failed or
  partially applied repositories
- `0` when resource inspection succeeds, including ignored unmatched resources
- `1` for validation errors, usage errors, command errors, failed repositories,
  partially applied repositories, or unmatched resources under the default
  policy

## Common options

```text
--path <path>            Configuration directory (default: .)
--format <text|json>     Output format (default: text)
--quiet                  Suppress normal output for template validate, plan, and apply
-v, --verbose            Include unchanged items and full diagnostic resource lists
--trace                  Emit GitHub API traces to stderr
--events-output <path>   Write resource events as NDJSON
```

`--verbose`, `--trace`, and `--events-output` apply to `plan` and `apply`.
`resource list` also supports `--trace`. `resource list`, `resource create`,
`template print`, `template validate`, and `template permissions` support
`--path` and `--format`.

## Grouped commands

The canonical grouped command surface is:

```text
octosmith resource list
octosmith resource create <template>
octosmith template validate
octosmith template permissions [template]
```
