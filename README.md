# OctoSmith

A toolkit for defining, validating, planning, and applying GitHub configuration
as code.

## Packages

- `@octosmith/octosmith` — OctoSmith domain models, planning, reporting, and
  GitHub integration.
- `@octosmith/cli` — command-line interface.

## Create a control repository

Scaffold a conservative OctoSmith organization control repository with:

```sh
deno create jsr:@octosmith/octosmith github-config
```

The scaffolder prompts for the GitHub organization when it is not supplied. For
non-interactive use, pass template options after Deno's `--` separator, for
example:

```sh
deno create jsr:@octosmith/octosmith github-config -- --organization acme
```

Additional options are `--collection-management explicit|strict`,
`--default-branch <name>`, `--no-workflows`, and `--event-streaming`.

When `--event-streaming` is enabled, the generated apply workflow uses a local
FIFO to stream `resource.applied` repository events into Hooksmith while
OctoSmith is still running. The generated `hooksmith.config.ts` simply logs each
applied repository and is intended as a starting point for richer reactions.

## GitHub Action

Use the repository-level Action to run the OctoSmith CLI from a workflow:

```yaml
steps:
  - uses: actions/checkout@v7

  - uses: Kralizek/octosmith@v0
    with:
      mode: apply
      github-token: ${{ secrets.OCTOSMITH_TOKEN }}
```

The Action delegates directly to the `@octosmith/cli` package source shipped in
the same Action release, following the same distribution pattern as Hooksmith.
It does not maintain a separate Action-specific CLI adapter.

Supported inputs are:

- `mode`: required, `validate`, `plan`, or `apply`
- `path`: configuration directory, default `.`
- `github-token`: GitHub credential required by `plan` and `apply`; not required
  by `validate`
- `repository`: optional repository target
- `format`: `text` or `json`, default `text`
- `verbose`: `true` or `false`, default `false`
- `events-output`: optional writable path for NDJSON Hooksmith resource events

The token is passed only through `GITHUB_TOKEN`; it is never added to CLI
arguments or output. The token must be able to read every organization and
repository resource used by `plan`. For `apply`, grant the corresponding write
permission for every resource OctoSmith is configured to manage. In most
organization-wide workflows this means using a fine-grained personal access
token. A GitHub App can also be used, but its short-lived installation token
should be minted during the workflow rather than stored as a long-lived secret.

Action releases maintain a moving major tag such as `v0` pointing at the latest
compatible 0.x release.

## Examples

See [`examples/configuration`](examples/configuration) for a sample
configuration directory covering repository scope, typed repository templates,
and managed files.
