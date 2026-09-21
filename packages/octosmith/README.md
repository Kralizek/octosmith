# @octosmith/octosmith

OctoSmith's domain model, configuration loader, planner, reporting, and GitHub
integration.

Create a new organization control repository with:

```sh
deno create jsr:@octosmith/octosmith github-config
```

The scaffolder is exposed through the package's `./create` export. Template
options must follow Deno's `--` separator, for example:

```sh
deno create jsr:@octosmith/octosmith github-config -- --organization acme
```

It supports `--organization`, `--collection-management explicit|strict`,
`--default-branch <name>`, `--no-workflows`, and `--event-streaming` for
non-interactive use.

The CLI is published separately as `@octosmith/cli`.
