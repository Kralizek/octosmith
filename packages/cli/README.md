# @octosmith/cli

The command-line interface for validating, inspecting, planning, and applying
Octosmith configuration to GitHub repositories.

## Install

```sh
deno install -A -n octosmith jsr:@octosmith/cli@0
```

Or run it without installing:

```sh
deno run -A jsr:@octosmith/cli@0 --help
```

## Common commands

```sh
octosmith template list --path .
octosmith template validate --path .
octosmith template permissions --path .
octosmith resource list --path .
octosmith resource create services --assisted --path .
octosmith plan --path .
octosmith apply --path .
```

`template` commands run offline. `resource list`, `plan`, and `apply` need
GitHub credentials. `apply` changes repositories; inspect the plan first.

`resource create` also changes GitHub and bootstraps a repository through Git.
By default it is strict and noninteractive. Opt into `--assisted` to choose
among effective naming patterns and visibility alternatives, or enter a missing
name. It requires interactive stdin/stderr terminals and cannot be combined with
`--format json` or `--dry-run`. Explicit arguments always take precedence. Type
`:cancel` at any question (or send EOF) to stop without creating a repository.

## Documentation

- [Command index](https://github.com/Kralizek/octosmith/blob/master/docs/cli/README.md)
- [Template commands](https://github.com/Kralizek/octosmith/blob/master/docs/cli/template-commands.md)
- [Resource inspection and creation](https://github.com/Kralizek/octosmith/blob/master/docs/cli/resource-commands.md)
- [Plan and apply](https://github.com/Kralizek/octosmith/blob/master/docs/cli/plan-and-apply.md)
- [Authentication, output, events, and options](https://github.com/Kralizek/octosmith/blob/master/docs/cli/operations.md)

For the desired-state configuration format, see the
[configuration guide](https://github.com/Kralizek/octosmith/blob/master/docs/configuration.md).
The [library package](https://jsr.io/@octosmith/octosmith) provides the
programmatic API.
