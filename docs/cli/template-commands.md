# Template commands

## template print

```sh
octosmith template print services --path ./configuration
octosmith template print repository:services --path ./configuration --format json
```

Prints the complete effective template after composing its reusable fragments.
The template argument accepts a short name or canonical `repository:` identity.
YAML is the default output; `--format json` emits the same schema-compatible
snake_case document as parseable JSON. The result contains `version`, `kind`,
`match`, and the synthesized `repository`, but no `includes`. Managed file
`source` paths and custom property names are preserved; file contents and
runtime secret/environment values are not resolved. The command is fully offline
and does not access GitHub.

## template list

```sh
octosmith template list --path ./configuration
octosmith template list --path ./configuration --format json
```

The command is fully offline and lists root repository templates only. Each row
contains the canonical template identity, optional display name, and defining
template path relative to the configuration root. Reusable fragments are not
listed. Invalid configuration fails rather than returning a partial list.

## template validate

```sh
octosmith template validate --path ./configuration
octosmith template validate teams/backend --path ./configuration
octosmith template validate repository:teams/backend --path ./configuration
octosmith template validate --path ./configuration --quiet
```

Validation does not access GitHub or resolve GitHub credentials. It reports all
discovered configuration errors, unreachable templates, and runtime-reference
diagnostics in one run. Supplying a template validates the root configuration
and only that template's template-specific rules. JSON output includes coded
diagnostics and the effective include/exclude constraints for each selected
template. Repeated diagnostics are compacted into a single message with a
`Referenced by` list, so shared problems across templates/resources do not have
to be fixed one at a time.

Use `--quiet` to suppress successful validation output. Errors remain on stderr
and the exit code is unchanged.

For environment-backed secrets, validation checks only whether the environment
variable is present. Present secrets do not produce `unresolved_secret`
warnings, and their values are never read into configuration, diagnostics, or
output. Missing secrets continue to produce warnings.

## template permissions

```sh
octosmith template permissions --path ./configuration
octosmith template permissions repository:libraries --path ./configuration
```

This offline command calculates the strongest GitHub permissions that the
reachable effective templates could require. Use `--format json` for structured
output or `--format github-output` to emit `permission-<name>=<access>` lines
for GitHub App token workflows. See [Permission output](#permission-output)
below for the exact semantics and limitations.

Use `template permissions services --creation --format json` (or text) to
separate organization repository creation authorization, selector metadata
assignments and post-creation reconciliation. This does not add creation
requirements to ordinary plan/apply analysis. Creation analysis cannot be
rendered as `github-output`, because those lifecycle scopes are distinct. See
[creation permissions](../automation.md#repository-creation-permissions).

## Permission output

`template permissions [template]` analyzes possible operations for all reachable
templates or one named template without a GitHub token or live repository state.
It uses the effective configuration (including fragments) and reports the
strongest required access for each repository or organization permission. Strict
collection management includes possible removals even for empty managed
collections. JSON output contains a `requirements` array of objects with
`scope`, `permission` (GitHub API name), and `access` fields. This is a
worst-case mutation requirement, not a report of current drift or all read
permissions needed to discover repository state.

`template permissions` additionally supports `--format github-output`, which
renders deterministic `permission-<name>=<access>` lines matching the
`permission-*` inputs of
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).
The output can be appended directly to `$GITHUB_OUTPUT` to mint a short-lived
installation token scoped to exactly what a workflow needs:

```sh
octosmith template permissions --path ./configuration \
  --format github-output >> "$GITHUB_OUTPUT"
```

```text
permission-administration=write
permission-contents=write
permission-issues=write
permission-members=read
permission-pull-requests=write
```

The upstream action does not support the repository Actions Variables
permission. If the selected configuration requires it, `github-output` fails
instead of emitting an ineffective `permission-variables` line; use another
supported token-creation method for that configuration.

Other commands that support `--format` only accept `text` or `json` and reject
`github-output`.
