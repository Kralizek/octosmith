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

Configuration and all templates are schema-validated before repository
discovery. Unknown keys, empty selectors, and unsupported configuration versions
are rejected. To explicitly select every repository, use
`scope: { names: ["*"] }`.

Review `plan` before applying: reports include resource names, file paths, and
changed settings. Runtime variable values and file contents are omitted, and
secret values are never included. Strict mode can delete undeclared members of
owned collections; explicit empty environment variable or secret lists also
clear those members in sparse mode.

Repository/environment variables and secrets declared by name in the
configuration are read from same-named environment variables at runtime. Values
are never stored in the OctoSmith configuration.

Before applying a repository plan, all required secret values are resolved and
snapshotted. A missing value prevents every mutation for that repository,
including deletions; other repositories can still be processed. Plan mode does
not require secret values. Secrets are written on each apply because GitHub
cannot expose their current values for comparison.

Apply is not transactional. A later API failure can leave earlier operations
applied; remaining operations for that repository are skipped. Failures result
in exit code 1. Each apply reads fresh state and builds a new plan; it does not
execute a previously displayed plan.
