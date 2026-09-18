# @octosmith/cli

Command-line interface for OctoSmith.

## Usage

Set `GITHUB_TOKEN` to a token with the repository and organization permissions
required by the policy being reconciled, then run:

```sh
octosmith plan --path ./configuration
octosmith apply --path ./configuration
```

Collection reconciliation defaults to sparse ownership. Use
`--collections strict` to make supported named collections authoritative.

Repository/environment variables and secrets declared by name in the
configuration are read from same-named environment variables at runtime. Values
are never stored in the OctoSmith configuration.
