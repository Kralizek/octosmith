# Root configuration file reference

`octosmith.yml` is the root of an Octosmith control repository. It declares
which GitHub organization or authenticated personal account and repositories are
in scope, and sets policies that apply to **all** managed repositories.
Repository-specific desired state lives in
[repository templates](repository-template.md).

The authoritative source is
[`schemas/octosmith.schema.json`](../schemas/octosmith.schema.json), which
references the
[repository scope schema](../schemas/scopes/repository.schema.json) and
[selector schema](../schemas/selectors/repository.schema.json). This page
explains the YAML-facing fields and runtime semantics. Validation also enforces
constraints beyond JSON Schema.

## Minimal configuration

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Kralizek/octosmith/master/schemas/octosmith.schema.json
version: 1
organization: acme

repositories:
  scope:
    include: all
```

For a personal account, keep the same key and use the authenticated user's
login:

```yaml
version: 1
organization: Kralizek

repositories:
  scope:
    include: all
```

- `version` **(required):** exactly `1`.
- `organization` **(required):** a non-empty GitHub organization login or
  personal-account login. For a personal account, Octosmith verifies that it is
  the authenticated user before any mutation. The historical key remains
  unchanged for existing configurations.
- `repositories` **(required):** an object containing `scope`, and optionally
  `settings` and `file_changes`.

Unknown keys are rejected at these levels. Neither root configuration nor
repository scope is a place to declare teams, rulesets, or individual files to
manage: those belong under a repository template's `repository` object.

## `repositories.scope`

`scope` is required and determines which existing GitHub repositories are
considered for template selection.

- `include` **(required):** `all` or a repository selector object.
- `exclude` **(optional):** a repository selector object. Matching exclusions
  are removed from scope even when they also match `include`.

A selector must contain at least one of:

- `names`: non-empty, unique list of repository name patterns. `*` matches any
  sequence and `?` matches one character. Any pattern can match.
- `teams`: non-empty, unique list of team names. A repository must have **all**
  listed teams.
- `properties`: non-empty mapping from custom-property names to expected values.
  Each value can be a string, boolean, or list of strings. All declared
  properties must match.
- `visibility`: `public`, `private`, `internal`, or a non-empty unique list of
  those values. Any listed visibility can match.

When a selector contains multiple fields, **all specified fields must match**.
`exclude` uses the same predicate as `include`.

Personal-account discovery uses the authenticated user's repository endpoint and
keeps only repositories whose canonical owner login matches the configured
account. Organization team selectors/permissions and organization custom
properties are unsupported for personal owners; they fail before repository
creation or reconciliation rather than being ignored.

```yaml
repositories:
  scope:
    include:
      names:
        - "service-*"
        - "library-*"
      visibility:
        - private
        - internal
    exclude:
      properties:
        octosmith-excluded: true
```

This selects repositories with an allowed name **and** visibility, apart from
those carrying the exclusion property. A repository excluded here never reaches
template matching or fallback selection.

## `repositories.settings`

The optional `settings` object defines organization-level reconciliation
policies. All listed keys are optional.

### Template selection

- `unmatched_repositories`: `error` (default), `ignore`, or `fallback`.
  - `error`: an in-scope repository without a matching template causes a
    failure.
  - `ignore`: leave it unmanaged but still show it as unmatched in inspection
    and plan summaries.
  - `fallback`: use the specified template when **zero** regular templates
    match.
- `fallback_template`: required **only** when
  `unmatched_repositories: fallback`; forbidden for other modes. Its value must
  be a canonical identity beginning with `repository:`, for example
  `repository:baseline`. The referenced template must exist.

```yaml
repositories:
  scope:
    include: all
  settings:
    unmatched_repositories: fallback
    fallback_template: repository:baseline
```

A file at `templates/baseline.yml` has identity `repository:baseline`. The
fallback template can omit `match`; ordinary templates cannot. If the fallback
also declares `match`, it participates in regular matching too.

Selection follows this order:

1. Discard repositories outside `scope`.
2. Evaluate all templates with explicit `match` predicates.
3. If exactly one matches, use it as the complete desired template.
4. If more than one matches, fail: fallback does not resolve ambiguity.
5. If none matches, apply the unmatched policy above.

**Fallback is not inheritance.** It does not contribute settings to another
template that matched. To share baseline settings, use
[fragments](repository-template.md#fragments-and-document-composition)
explicitly from the matching templates. Fallback state is applied normally,
including changes or removals permitted by the root policies; review the scope
before using a powerful fallback baseline.

### Reconciliation policies

- `collection_management`: `explicit` (default) or `strict`. `explicit`
  preserves undeclared members of supported collections; `strict` makes
  supported collections authoritative and may remove undeclared members. Neither
  mode implicitly deletes managed files: `ensure: absent` must be declared
  explicitly.
- `secrets`: `automatic` (default) or `manual`. With `manual`, fresh plan/apply
  excludes repository Actions, Dependabot, and environment secret
  reconciliation. `--include-secrets` opts back in. Saved plans replay their
  stored operations rather than reinterpreting this setting.
- `default_branch_drift`: `ignore` (default) or `enforce`. On existing
  initialized repositories, `ignore` leaves the default branch alone. `enforce`
  reconciles an explicitly declared `repository.settings.default_branch` only
  when that branch already exists; it does not create or rename branches.

```yaml
repositories:
  scope:
    include: all
  settings:
    collection_management: explicit
    secrets: manual
    default_branch_drift: ignore
    unmatched_repositories: error
```

These policies control interpretation of each effective repository template;
they are **not** properties of a template or fragment. For operational details,
see [configuration behavior](configuration.md).

## `repositories.file_changes`

Configures how managed-file deltas are delivered. This object is optional. If
absent, the effective default is `mode: pull_request`. If present, it **must**
contain `mode`:

- `mode: pull_request` supports optional `commit` and `pull_request`.
- `mode: direct` supports optional `commit` but **not** `pull_request`.

`commit.message` is an optional non-empty string. In pull-request mode,
`pull_request` can contain:

- `branch_prefix`: non-empty string.
- `title`: non-empty string.
- `introduction`: Markdown string, including an empty string.
- `labels`: unique list of non-empty label strings.

```yaml
repositories:
  scope:
    include: all
  file_changes:
    mode: pull_request
    commit:
      message: "Octosmith: reconcile {repository}"
    pull_request:
      branch_prefix: "octosmith/"
      title: "Octosmith: reconcile {repository}"
      introduction: "Review these centrally managed file changes."
      labels:
        - automation
```

Commit messages and PR titles support `{organization}` and `{repository}`
placeholders. PR `introduction` is literal Markdown, not a placeholder template.
Use `mode: direct` only when direct writes to the target branch are intended;
normal GitHub protections remain in effect.

## Validation and related references

Run `octosmith template validate --path .` before planning. Static validation
does not need GitHub credentials. To see effective template names and paths, run
`octosmith template list --path .`; to check selection against actual
repositories, run `octosmith resource list --path .`.

- [Repository template reference](repository-template.md): file structure,
  managed-resource fields, matching, fragments, and composition.
- [Configuration behavior](configuration.md): runtime values, secrets,
  bootstrap, file-delivery lifecycle, and operational nuances.
- [CLI commands](cli/README.md): validation, inspection, planning, and apply.
