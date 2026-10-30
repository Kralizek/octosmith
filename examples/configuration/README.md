# Example Octosmith configuration

This directory is a design fixture for the Octosmith configuration model.

The filesystem acts as the registry:

- `octosmith.yml` defines the deployment scope.
- every file under `templates/` fully describes one repository family.
- `files/` contains content copied into managed repositories.

Every repository in scope is expected to match exactly one template. Templates
in this example are intentionally self-contained. Real configurations can also
compose reusable fragments when policy is shared across templates.

The corresponding organization/repository preconditions and expected resolved
desired states live under `tests/fixtures/configuration/`. The fixtures reuse
this directory as their policy input instead of duplicating the configuration.

Names used in this example are generic and do not represent any specific
organization.

Creation is strict and noninteractive unless explicitly assisted:

```sh
# Offline preview; never prompts or creates a repository.
octosmith resource create code --path examples/configuration --dry-run
# Actual creation; resolve only ambiguous naming patterns, missing names or visibility.
octosmith resource create code --path examples/configuration --assisted
```

Assisted creation requires interactive stdin/stderr terminals and rejects JSON
and dry-run. Explicit `--name` and `--visibility` take precedence. Single naming
patterns generate automatically; fixed teams/properties never prompt. Type
`:cancel` or send EOF to cancel before any repository is created. See
[creation options and recovery](../../docs/cli/resource-commands.md#resource-create).

The code template demonstrates `repository.post_create_commands`, requiring the
.NET SDK only on the host performing actual `resource create`. The executables
run sequentially in the temporary repository root before managed files;
declarative content wins and `ensure: absent` removes generated output.
Remaining generated files honor `.gitignore` and join the same raw-byte initial
commit. Plan/apply, validation, inspection and read-only preview never run or
probe the tools; preview omits arguments. Hooks are trusted host programs, not
sandboxed. Launch/nonzero failures stop before push, clean the workspace and
retain the remote without rollback of external side effects. Repair it manually
rather than rerunning create. See the
[configuration reference](../../docs/configuration.md#create-only-bootstrap-commands)
for execution isolation, list replacement and safe failure reporting.
