# CLI reference

Install `@octosmith/cli` with Deno:

```sh
deno install -A -n octosmith jsr:@octosmith/cli@0
```

For a guided first run, see [getting started](../getting-started.md). The
following pages contain the full command syntax, behavior, and examples.

| Guide                                     | What it covers                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [Template commands](template-commands.md) | Printing, listing, validating, and calculating permissions            |
| [Resource commands](resource-commands.md) | Inspecting resources and creating repositories                        |
| [Plan and apply](plan-and-apply.md)       | Plan artifacts, safe execution, targeting, and runtime-value policies |
| [Operational reference](operations.md)    | Authentication, output, events, exit codes, and common options        |

## Command summary

| Command                                | GitHub access | Mutates GitHub |
| -------------------------------------- | ------------- | -------------- |
| `template print <template>`            | No            | No             |
| `template list`                        | No            | No             |
| `template validate [template]`         | No            | No             |
| `template permissions [template]`      | No            | No             |
| `resource list`                        | Yes           | No             |
| `resource create <template>`           | Yes           | Yes            |
| `resource create <template> --dry-run` | No            | No             |
| `plan [repository]`                    | Yes           | No             |
| `apply [repository]`                   | Yes           | Yes            |

These commands accept `--path` to select a configuration directory.
