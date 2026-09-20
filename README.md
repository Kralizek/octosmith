# OctoSmith

A toolkit for defining, validating, planning, and applying GitHub configuration
as code.

## Packages

- `@octosmith/octosmith` — OctoSmith domain models, planning, reporting, and
  GitHub integration.
- `@octosmith/cli` — command-line interface.

## GitHub Action

Use the repository-level Action to run the OctoSmith CLI from a workflow:

```yaml
steps:
  - uses: actions/checkout@v7

  - uses: Kralizek/octosmith@v1
    with:
      mode: apply
      github-token: ${{ secrets.OCTOSMITH_TOKEN }}
```

The Action executes the CLI source from the same checked-out Action ref, so a
versioned Action tag runs the matching OctoSmith implementation instead of
downloading an unpinned latest version.

Supported inputs are:

- `mode`: required, `plan` or `apply`
- `path`: configuration directory, default `.`
- `github-token`: required GitHub credential
- `repository`: optional repository target
- `format`: `text` or `json`, default `text`
- `verbose`: `true` or `false`, default `false`

The token is passed only through `GITHUB_TOKEN`; it is never added to CLI
arguments or output. Action releases should maintain a moving major tag such as
`v1` pointing at the latest compatible v1 release.

## Examples

See [`examples/configuration`](examples/configuration) for a sample
configuration directory covering repository scope, typed repository templates,
and managed files.
