# Resource inspection and creation

## Automatic initialization during apply

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
[configuration guide](../configuration.md#default-branch-and-automatic-initialization)
for protection, concurrency, and retry limitations.

## resource list

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

## resource create

```sh
octosmith resource create services --path ./configuration
octosmith resource create services --name api-service --visibility private --path ./configuration
octosmith resource create services --assisted --path ./configuration
octosmith resource create services --format json --path ./configuration
octosmith resource create services --dry-run --path ./configuration
octosmith resource create services --name team-orders-svcs --visibility internal --dry-run
octosmith resource create services --dry-run --format json
```

Without `--dry-run`, creation **mutates GitHub** using the same authentication
as plan/apply. It creates an empty repository in the configured organization or
authenticated personal account, assigns required teams/custom properties,
re-reads metadata and verifies scope and unique template classification, then
reconciles safe GitHub-side resources. It then bootstraps all composed managed
files in one local Git commit and one push, re-reads GitHub state and finishes
deferred reconciliation. `--dry-run` remains an offline, read-only preview. Both
paths use the same reusable library specification, which resolves the template,
validates it with the same semantic checks as `template validate`, and reports
the effective name, visibility, team, and custom-property constraints. If
scope/template intersection yields one constructible naming pattern, an omitted
name is generated from it; patterns with no `*` or `?` use their literal name.
Use `--name` to override generation, or to select among multiple patterns.
Visibility is inferred when uniquely constrained; use `--visibility` when
multiple valid values remain. Ambiguities and configuration errors are returned
as structured diagnostics (including in JSON output) and exit unsuccessfully
before any GitHub access in the default **strict mode**, which never prompts.
Names are generated once per execution; a collision fails without adopting an
existing repository or generating a replacement name.

The existing root `organization:` key accepts either an organization login or
the authenticated personal-account login. Organization creation and discovery
retain their organization endpoints. Personal creation uses the authenticated
user endpoint; discovery filters `/user/repos` by canonical owner so shared
repositories are excluded. Octosmith rejects another personal user's login and
fails before mutation when organization-only team or custom-property intent is
configured. Offline previews display the configured owner; execution resolves
its canonical login and owner type before repository work.

### Assisted creation

`--assisted` opts into resolving only genuine preflight ambiguities. It requires
both stdin and stderr to be interactive terminals, and is incompatible with
`--format json` and `--dry-run`. These checks happen before GitHub access.
Questions use the terminal on stderr, not normal stdout output.

- Multiple effective naming strategies: choose a numbered pattern. The shared
  preflight generates the name securely and checks include/exclude constraints
  and unique template classification. Patterns that cannot be safely resolved
  are not selectable; supply an explicit `--name` instead.
- No naming pattern: enter a repository name. Invalid manual names report the
  ordinary preflight diagnostics and can be corrected.
- Ambiguous visibility: choose a numbered visibility with a readable
  description, limited to current effective constraints.

Single naming strategies generate automatically; uniquely determined visibility,
teams and custom properties never need confirmation. Explicit `--name` and
`--visibility` bypass their questions; invalid explicit values fail instead of
being replaced. Configuration errors, incompatible constraints and template
overlaps cannot be bypassed by questions.

Type `:cancel` at any question, send EOF, or interrupt with Ctrl+C to stop
before creation. A closed input stream also cancels. No credentials or GitHub
calls are needed until preflight succeeds. Each choice is fed back to
authoritative preflight. The final resolved name is then passed explicitly to
the existing creation lifecycle, which performs preflight again without
generating a second name. Collision handling and all later
bootstrap/reconciliation behavior remain unchanged; assisted mode never adopts
or retries an existing repository.

### Creation lifecycle and recovery

Immediate reconciliation includes repository settings (except deferred fields),
team permissions, custom properties, Actions settings/OIDC/variables/secrets,
Dependabot secrets, and environments and their variables/secrets. Secret,
collection-management and runtime-value policies are unchanged; use
`--include-secrets` or `--skip-missing-values` for the same explicit overrides.
As with plan/apply, `--include-secrets=true` opts in and
`--include-secrets=false` honors the configured mode. Required teams initially
receive read access, followed by declared permissions through normal
reconciliation. Strict collections cannot remove metadata needed for
scope/classification; declare required entries explicitly.

Git bootstrap uses a private temporary workspace and Git installed on `PATH`. It
creates exactly one commit, authored and committed by
`Octosmith <octosmith@users.noreply.github.com>`, with message
`Initial repository bootstrap`. Identity/configuration is repository-local;
global/system configuration and hooks are isolated. With no remaining staged
files it creates an empty commit, not a placeholder file. `exists` and `exact`
files use normal desired-state content resolution (including fragments and
overrides); `absent` files remove generated output. Raw blobs preserve resolved
UTF-8 bytes and line endings even with `.gitattributes` or `.gitignore`.
Invalid/escaping paths and `.git` aliases are rejected before push. Temporary
files are cleaned up on success and failure; cleanup errors are reported
separately.

Optional
[`repository.post_create_commands`](../repository-template.md#post_create_commands)
run sequentially after Git initialization/identity setup and before managed
files. These trusted executables must be installed on the creation host. They
receive literal argument arrays, no shell or interactive input, and an isolated
environment without forwarded host secrets or Git credentials. They are not
sandboxed and can affect the host or network; stdout/stderr are captured rather
than streamed. There is no runtime expansion or automatic retry.

Generated files honor the final `.gitignore`; managed files always win and are
included even if ignored. `ensure: absent` removes generated content before
staging. All files use raw Git blobs without attribute filters or line-ending
conversion; `write-tree`/`commit-tree` avoid filter execution during commit,
too. Unsafe generated paths, symlinks, special files, and Git-internal aliases
fail before staging; root `.git` is excluded. Commands must not alter Git
metadata. See
[bootstrap command execution](../configuration.md#create-only-bootstrap-commands)
for the execution environment and portable path rules.

The branch is the template-managed `repository.settings.default_branch`, then
the organization/enterprise default resolved by GitHub on the newly created
repository's `default_branch`, then GitHub's documented `main` fallback if
unavailable
([GitHub branch defaults](https://docs.github.com/en/pull-requests/reference/branches#about-the-default-branch)).
The same branch becomes the repository default after push, even when ongoing
default-branch drift enforcement is disabled. Slash-containing branches are
supported. Existing history or unexpected branches stop bootstrap; there is no
adoption, force push or automatic push retry.

Creation never sends Contents API writes or creates file-update PRs under either
delivery mode. Both API reconciliation passes use `github-only`; managed files
are delivered only by the initial commit, avoiding per-file commits and partial
content. Default-branch changes, all rulesets (including push rulesets) and
archival wait until after push. Metadata/classification and current state are
re-read, a fresh ordinary plan is built, and archival is applied last. Completed
API deltas are not replayed; opaque secrets already delivered and still present
are preserved within this lifecycle. Ordinary plan/apply behavior is unchanged.

Git-over-HTTPS uses the same explicit/environment/`gh auth token` authentication
as API access. Tokens are never embedded in remote URLs, command arguments,
configuration, diagnostics or output. A static temporary askpass helper reads
the token from the isolated push child's environment; credential helpers and
interactive prompts are disabled. The token must have Git Contents: write and,
for workflow files, Workflows: write (classic PATs need the appropriate
`repo`/`public_repo` and `workflow` scopes). API creation authorization does not
guarantee push authorization: installation selection, SSO, Actions token scope,
organization policies and GitHub App permissions still apply. Git failures are
reported with safe categories, never raw credential-bearing diagnostics.

An already-satisfied `archived: false` does not trigger a deferral; unarchiving
can proceed before bootstrap. Post-creation failures retain configured deferred
work even if runtime resolution or state reading fails. Deferred settings are
explicitly named in the regular text report.

Text and JSON separate lifecycle status/stages, identity/URL, metadata
assignment outcomes, branch, prepared/commit/push progress, initial SHA, staged
file count (including generated files), deferred work, and both ordinary
reconciliation reports. Only `completed` exits 0. `bootstrap_failed` and
`bootstrapped_not_reconciled`, as well as preflight, collision, creation,
assignment, classification or reconciliation failures, exit 1. No reconciliation
report is invented before reconciliation is attempted. API/provider error bodies
are omitted to avoid exposing runtime values.

Creation is not transactional: Octosmith never deletes a partially created
repository. Failed metadata assignments or classification require manual repair
and verification; ordinary apply cannot discover an out-of-scope repository. Do
**not** rerun `resource create` for a retained repository: its name will
collide. Before a push attempt, no bootstrap content was sent; correct the
failure and initialize the retained repository manually, then run ordinary
plan/apply. Command launch/nonzero failures use `post_create_command` and the
one-based `failedCommand` ordinal, omitting sensitive arguments and raw output.
Later commands and all content delivery stop; `pushAttempted` remains false. The
remote is retained and external command side effects are not rolled back. For a
rejected push, repair the permissions/policy and inspect remote state before
manually pushing the intended initial commit. For `push_unknown` (for example a
lost connection after sending), remote changes are uncertain: compare the
reported initial SHA with GitHub's branch head before taking any action. Never
force-push or assume the repository is empty. After a confirmed push with failed
deferred work, repair the reported failure and run fresh plan/apply; verify/set
the resolved default branch first if that operation failed and ongoing drift
enforcement is disabled. Unarchive manually if needed before repairs. A cleanup
warning requires inspecting local temporary storage. After a lost creation
response, inspect GitHub before explicitly retrying.

`--dry-run` extends preflight with a creation preview, not a drift report
against an imaginary repository. Text and JSON report:

- Configured owner, canonical template, name origin, visibility, and
  selector-required team/custom-property assignments.
- Bootstrap default branch when template-managed, and composed managed-file
  paths with intended presence/absence. The planned file count counts only
  present files, not absence declarations. File contents are never printed.
- Ordered post-create executable names and count, never argument values.
  Generated files cannot be predicted offline; the planned file count remains
  the declarative present-file count.
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
the owner's default repository branch, then GitHub's documented fallback.
Offline preview cannot inspect the remote owner or default branch, so without a
template-managed branch it reports **deferred**, not an invented branch name.

A **generated preview name is provisional and not reserved**. Execution may
generate a different name unless you pass the displayed name explicitly with
`--name`. Preview does not cache or persist names. When choices are unresolved,
it reports prospective naming patterns and diagnostics instead of generating a
name just for display. It still fails with a nonzero exit status; JSON remains
structured on failures. No filesystem writes, Git commands, commits, pushes, or
bootstrap commands are executed or probed by preview. Commands also never run
during ordinary plan/apply, validation, or inspection. Assisted prompting (#113)
remains a future milestone.

Preview JSON uses `kind: repository_creation_preview` and `version: 1`,
including unresolved preflight results (`ready: false`). If configuration cannot
be loaded at all, JSON instead uses
`kind: repository_creation_configuration_error` with a
`configuration_load_error` diagnostic. Raw parser errors are not echoed because
they may contain sensitive configuration snippets; use `template validate` to
investigate the configuration.

Version 1 adds `bootstrap.postCreateCommands` (ordered `{ command }` summaries)
and `bootstrap.postCreateCommandCount`; these additive fields do not change the
existing structured preview contract or include arguments.
