# @octosmith/cli

Command-line interface for Octosmith.

The CLI validates configuration, compares desired state with GitHub, applies
changes, renders reports, and can emit per-repository resource events.

For the configuration format and desired-state model, see
[`@octosmith/octosmith`](../octosmith/README.md).

For GitHub Actions, generated workflows, credentials, and event streaming, see
the repository [automation guide](../../docs/automation.md).

## Install

```sh
deno install -A -n octosmith jsr:@octosmith/cli@0
```

You can also run it directly with Deno:

```sh
deno run -A jsr:@octosmith/cli@0 --help
```

## Commands

Newly created repositories do not need an initial README or commit:

```sh
gh repo create acme/repo --private
octosmith apply -p .
```

For in-scope repositories matching a template, `apply` automatically initializes
missing Git history before installing managed rulesets, even without managed
files. Initialization is API-only; Git is not a local dependency. `plan` reports
initialization without mutating the repository. The initial branch is the
declared `repository.settings.default_branch`, or bootstrap-only `main` when
omitted. Initialized repositories preserve their default branch unless the root
`repositories.settings.default_branch_drift: enforce` policy is set and the
template explicitly declares a branch that already exists.

The first commit contains the reserved, recognizable
`.github/.octosmith-bootstrap` file. Direct delivery adds desired files and
removes it in one subsequent commit. PR delivery removes it in the managed-file
PR, or a cleanup-only PR when no files are declared. Managed rulesets are
deferred until that cleanup PR merges. Existing and inherited policies are never
bypassed. Recognized partial bootstrap state is recovered by a fresh plan
without another initial commit; unexpected reserved-file contents are reported
and preserved. See the
[configuration guide](../../docs/configuration.md#default-branch-and-automatic-initialization)
for protection, concurrency, and retry limitations.

| Command                           | GitHub access | Mutates GitHub | Purpose                                                         |
| --------------------------------- | ------------- | -------------- | --------------------------------------------------------------- |
| `template print <template>`       | No            | No             | Print a synthesized repository template                         |
| `template validate`               | No            | No             | Validate configuration and static planner invariants            |
| `template permissions [template]` | No            | No             | Calculate worst-case GitHub permissions for reachable templates |
| `resource list`                   | Yes           | No             | Inspect in-scope resources and template coverage                |
| `resource create <template>`      | No            | No             | Offline preflight, or creation preview with `--dry-run`         |
| `plan [repository]`               | Yes           | No             | Compare current GitHub state with desired state                 |
| `apply [repository]`              | Yes           | Yes            | Build or execute a plan and apply its operations                |

### template print

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

### template list

```sh
octosmith template list --path ./configuration
octosmith template list --path ./configuration --format json
```

The command is fully offline and lists root repository templates only. Each row
contains the canonical template identity, optional display name, and defining
template path relative to the configuration root. Reusable fragments are not
listed. Invalid configuration fails rather than returning a partial list.

### template validate

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

### template permissions

```sh
octosmith template permissions --path ./configuration
octosmith template permissions repository:libraries --path ./configuration
```

This offline command calculates the strongest GitHub permissions that the
reachable effective templates could require. Use `--format json` for structured
output or `--format github-output` to emit `permission-<name>=<access>` lines
for GitHub App token workflows. See [Permission output](#permission-output)
below for the exact semantics and limitations.

### resource list

```sh
octosmith resource list --path ./configuration
octosmith resource list --path ./configuration --format json
```

Inspection uses the same GitHub authentication and discovery as plan/apply.
Resources excluded by configuration scope are absent. A template exclusion
affects only that template; another template may still match. Inspection does
not read desired-state values, managed-file contents, or reconciliation state.

```text
TYPE        NAME                 TEMPLATE                  STATUS
repository  acme/api-service     repository:teams/backend  matched
repository  acme/core-service    repository:baseline       fallback
repository  acme/legacy-service  -                         unmatched

Summary: 1 matched, 1 fallback, 1 unmatched
```

JSON preserves every discovered in-scope resource and uses canonical template
identities:

```json
{
  "resources": [
    {
      "type": "repository",
      "name": "acme/api-service",
      "template": "repository:teams/backend",
      "status": "matched"
    },
    {
      "type": "repository",
      "name": "acme/core-service",
      "template": "repository:baseline",
      "status": "fallback"
    },
    {
      "type": "repository",
      "name": "acme/legacy-service",
      "template": null,
      "status": "unmatched"
    }
  ],
  "summary": { "matched": 1, "fallback": 1, "unmatched": 1 }
}
```

Unmatched resources are shown before the command exits with code `1` by default.
For repository resources, `repositories.settings.unmatched_repositories: ignore`
allows success while retaining `template: null` and `status: "unmatched"`. With
`unmatched_repositories: fallback`, unmatched repositories instead show the
configured template with `status: "fallback"`; they participate in normal
planning and apply. `--template repository:baseline` includes repositories
selected through that fallback. Inspection and plan/apply summaries count
fallback selections separately. Multiple template matches remain an error, not
an inspection status. Discovery failures also fail the command and are diagnosed
on stderr; successfully discovered resources are still reported.

### resource create

```sh
octosmith resource create services --path ./configuration
octosmith resource create services --name api-service --visibility private --path ./configuration
octosmith resource create services --format json --path ./configuration
octosmith resource create services --dry-run --path ./configuration
octosmith resource create services --name team-orders-svcs --visibility internal --dry-run
octosmith resource create services --dry-run --format json
```

Without `--dry-run`, creation currently performs an offline preflight only; it
does not create a GitHub repository. This is transitional: future releases will
execute creation by default, while `--dry-run` will remain the explicit
read-only preview. Both paths use the same reusable library specification, which
resolves the template, validates it with the same semantic checks as
`template validate`, and reports the effective name, visibility, team, and
custom-property constraints. If scope/template intersection yields one
constructible naming pattern, an omitted name is generated from it; patterns
with no `*` or `?` use their literal name. Use `--name` to override generation,
or to select among multiple patterns. Visibility is inferred when uniquely
constrained; use `--visibility` when multiple valid values remain. Ambiguities
and configuration errors are returned as structured diagnostics (including in
JSON output) and exit unsuccessfully. No prompt, credential lookup, GitHub
access, or remote mutation occurs.

`--dry-run` extends preflight with a creation preview, not a drift report
against an imaginary repository. Text and JSON report:

- Resolved organization, canonical template, name origin, visibility, and
  selector-required team/custom-property assignments.
- Bootstrap default branch when template-managed, and composed managed-file
  paths with intended presence/absence. The planned file count counts only
  present files, not absence declarations. File contents are never printed.
- Concise desired-resource summaries for settings, teams, custom properties,
  Actions, Dependabot, environments, and rulesets. `resolved` means configured
  intent is known, not that any API operation has been calculated or performed.
  `not_applicable` means there is no configured work in that category beyond
  separately reported creation requirements. Collection and secret policies are
  included; manual-policy secrets remain excluded unless execution opts in.
- Deferred execution-time work: name availability, remote classification
  verification, exact GitHub reconciliation, and runtime-backed values. Secret
  and variable values, runtime credentials, and managed-file contents are
  omitted.

Default-branch precedence is template `repository.settings.default_branch`, then
the organization's default repository branch, then GitHub's documented fallback.
Offline preview cannot inspect the organization default, so without a
template-managed branch it reports **deferred**, not an invented branch name.

A **generated preview name is provisional and not reserved**. Execution may
generate a different name unless you pass the displayed name explicitly with
`--name`. Preview does not cache or persist names. When choices are unresolved,
it reports prospective naming patterns and diagnostics instead of generating a
name just for display. It still fails with a nonzero exit status; JSON remains
structured on failures. No filesystem writes, Git commands, commits, pushes, or
bootstrap commands are executed. Actual creation, content bootstrap, and
assisted prompting remain future milestones.

Preview JSON uses `kind: repository_creation_preview` and `version: 1`,
including unresolved preflight results (`ready: false`). If configuration cannot
be loaded at all, JSON instead uses
`kind: repository_creation_configuration_error` with a
`configuration_load_error` diagnostic. Raw parser errors are not echoed because
they may contain sensitive configuration snippets; use `template validate` to
investigate the configuration.

### plan

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration
GITHUB_TOKEN=... octosmith plan --path ./configuration --quiet
```

`plan` reads GitHub and reports the operations required to reach the desired
state. It does not mutate GitHub. Participating secrets must have runtime
sources available; their values are never included in the plan or report.

Use `--template <template>` to limit planning to repositories classified with a
template. The value may be a template name or its canonical identity:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --template repository:libraries
```

An existing template with no matching repositories produces an empty successful
report. A template filter cannot be combined with a positional repository
target.

Use `--quiet` to suppress the normal planning report. It can be combined with
`--out` to write a persisted plan without printing the report:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --out plan.json --quiet
```

Planning failures remain visible on stderr; a failed persisted plan is not
written.

Unmatched repositories include the effective policy and its consequence. The
summary reports repository statuses, operation outcomes, and skipped runtime
bindings separately. Operation counts come from apply-item outcomes. A skipped
operation is a planned change that was not executed after another resource
failed during preparation; unchanged items are not counted. Skipped runtime
bindings count distinct template bindings excluded by `--skip-missing-values`;
these values are not interchangeable:

```text
Unmatched repositories (3):
  Policy: ignore
  These repositories are excluded from reconciliation.

  - legacy-service
  - archived-service
  - docs-site

Warnings:
  Skipped runtime values:
    SLACK_BOT_OPERATION_TOKEN (secret) — 21 repositories
    COPILOT_REVIEW_TOKEN (secret) — 21 repositories

  42 bindings excluded from reconciliation.
  Existing destination values will not be modified or deleted.

Summary:
  Repositories: 21 planned, 0 unchanged, 0 applied, 0 partially-applied, 0 failed, 0 fallback, 3 unmatched
  Operations:   87 planned, 0 applied, 0 failed, 0 skipped
  Exclusions:   42 skipped runtime bindings
```

Fresh plan/apply JSON reports include an `inspection` object with the same
`resources` and `summary` shape as `resource list`. Classification is
independent of execution outcomes: under the default policy an unmatched
resource also has a failed execution report; under `ignore` it has no execution
report but remains visible in inspection. Fallback-selected repositories have
normal execution reports and persisted operations under the fallback template.
Ignored resources do not generate execution events or persisted operations.
Applying a persisted plan reports only its stored resource set, without a new
scope-wide inspection.

Use `--out <file>` to persist the exact executable operations:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --out plan.json
```

The persisted artifact is distinct from `--format json` output. It may contain
resolved variables and managed-file contents, but never resolved secret values.

All new persisted artifacts use version 2, even when secrets are included or no
resources are selected. Version 2 adds optional resource-level
`secretsExcluded: true`; omission means secrets were not excluded by policy.
Version 1 is the legacy format and does not accept that property. Octosmith
continues accepting and executing version-1 plans without regeneration,
automatic upgrading, or replanning. Older releases may not read version-2 plans.
The configuration schema version remains 1.

### apply

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration
GITHUB_TOKEN=... octosmith apply --path ./configuration --quiet
```

`apply` reads fresh GitHub state, builds a new plan, and applies that plan by
default.

Use `--quiet` to suppress the normal report. Errors remain on stderr and the
exit code is unchanged.

Use `--template <template>` to apply only repositories classified with that
template:

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration --template repository:libraries
```

Use `--plan <file>` to execute a persisted plan:

```sh
GITHUB_TOKEN=... octosmith apply --path ./configuration --plan plan.json
```

Template-scoped plans can be persisted and later applied without repeating the
template filter:

```sh
GITHUB_TOKEN=... octosmith plan --path ./configuration --template repository:libraries --out libraries.plan.json
GITHUB_TOKEN=... octosmith apply --path ./configuration --plan libraries.plan.json
```

Persisted apply verifies root configuration, effective resource templates, and
template-owned remote state before the first mutation. A stale preflight reports
each resource as `valid`, `template`, or `state` and applies nothing. Resource
state is checked again immediately before mutation. Stored operations are
executed exactly and are never rebuilt.

PR-mode artifacts also contain the complete desired managed files and target
commit snapshot, but never PR numbers, URLs, or lifecycle commands. Target
advancement or missing snapshots require a new plan. An empty operation list
still runs apply-time PR reconciliation and can close an obsolete PR. Direct
delivery retains its existing managed-path concurrency semantics.

Apply is not transactional. If one operation fails, earlier operations for that
repository may already have been applied. Remaining operations for that
repository are skipped, and Octosmith stops before mutating later repositories.

## Secret opt-in

Both `plan` and fresh `apply` accept an optional boolean:

```sh
octosmith plan --include-secrets
octosmith plan --include-secrets=true
octosmith plan --include-secrets=false
octosmith apply --include-secrets
octosmith apply --include-secrets=true
octosmith apply --include-secrets=false
```

The default configured mode is `automatic`, which includes secrets in every
fresh run. With `repositories.settings.secrets: manual`, only the bare flag or
explicit `true` opts secrets in. Explicit `false` respects the configured mode;
it does not force secrets off. Invalid explicit values such as `yes`, `1`, or
`maybe` fail argument parsing.

Manual exclusion covers Actions, Dependabot, and environment secrets, preserves
remote secrets even under strict management, and requires no secret inputs.
Variables and other resources continue reconciling. Text and JSON reports
explain policy exclusion without enumerating secret names. The independent
`--skip-missing-values` flag still governs missing participating inputs.

With `apply --plan`, all three flag forms are accepted but ignored. Saved
operations and exclusions are authoritative, even after the configured mode
changes. Mode-only changes leave configuration hashes valid; real configuration,
template, state, and replay dependency changes remain checked.

## Target one resource

`plan` and `apply` accept an optional resource target immediately after the
command:

```sh
octosmith plan api-service --path ./configuration
octosmith apply api-service --path ./configuration
```

The target narrows the configured scope; it does not override it. Today the only
supported top-level resource target is a repository, so a resource outside
`repositories.scope` is rejected and never mutated.

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

### Permission output

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

## Grouped commands

The canonical grouped command surface is:

```text
octosmith resource list
octosmith resource create <template>
octosmith template validate
octosmith template permissions [template]
```
