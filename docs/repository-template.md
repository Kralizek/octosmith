# Repository template file reference

A YAML file under `templates/` describes how Octosmith selects a repository
and the **desired state** to apply to it. This reference follows the canonical
[template schema](../schemas/template.schema.json), the
[repository resource schema](../schemas/resources/repository.schema.json),
and the separate [fragment schema](../schemas/fragment.schema.json).
See [root configuration](root-configuration.md) for organization-wide scope,
fallback selection, collection management, and file-delivery policy.

## Template structure and identity

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Kralizek/octosmith/master/schemas/template.schema.json
version: 1
kind: repository
name: Services

match:
  include:
    names:
      - "service-*"

includes:
  - ../fragments/common.yml

repository:
  settings:
    has_issues: true
  teams:
    - name: platform
      permission: maintain
```

A repository template supports these top-level keys:

- `version` **(required):** exactly `1`.
- `kind` **(required):** exactly `repository`.
- `name` **(optional):** non-empty display name. It does not affect identity
  or selection.
- `match` **(conditionally required):** repository-selection scope. It can be
  omitted only by the template configured as the root fallback.
- `includes` **(optional):** non-empty list of fragment paths, in order.
- `repository` **(required):** desired-state object, which can be `{}`
  when all state comes from fragments.

Unknown top-level keys are rejected. Templates are discovered **recursively**
inside `templates/` as `.yml` or `.yaml` files. Their stable identity comes
from the relative path, not `name`:

- `templates/services.yml` → `repository:services`
- `templates/teams/backend.yaml` → `repository:teams/backend`

Use these canonical identities in `fallback_template` and anywhere a canonical
template name is expected. In CLI commands, the `repository:` prefix can
usually be omitted. Fragments are stored separately and are not templates.

## `match`: which repositories use this template?

`match` has the same shape as root `repositories.scope`:

- `include` is required, either `all` or a selector.
- `exclude` is an optional selector. Exclusions win over inclusion.
- A selector can contain `names` (glob patterns), `teams` (all listed teams
  required), `properties` (all listed properties required), and `visibility`
  (one allowed value or a list).
- Fields within one selector combine with **AND**. A list of name patterns or
  visibility values combines with **OR**.

```yaml
match:
  include:
    names:
      - "service-*"
    properties:
      workload: backend
  exclude:
    names:
      - "service-legacy-*"
```

Root scope is applied **before** template matching. A repository should match
exactly one regular template. Multiple matches are an error, not an ordering
or priority rule. To cover otherwise unmatched repositories, configure a
[fallback template](#fallback-templates) from `octosmith.yml`.

## `repository`: desired state

Only declared categories and values are managed under the root's collection
policies; an omitted field is not automatically a request to reset it. See the
[resource schema](../schemas/resources/repository.schema.json) for exact JSON
types, conditionals, and permitted rule kinds.

### `settings`

Repository metadata and GitHub behavior. All keys are optional:

- Identity and visibility: `description` (string or null), `website`
  (string or null), `visibility` (`public`, `private`, `internal`),
  `topics` (unique string list), `is_template` (boolean).
- Features: `has_wiki`, `has_issues`, `has_projects`,
  `has_discussions`, `has_pull_requests` (booleans).
- Pull requests: `pull_request_creation_policy` (`all` or
  `collaborators_only`), `delete_branch_on_merge` (boolean).
- Other settings: `default_branch` (non-empty string),
  `allow_forking`, `archived`, `web_commit_signoff_required` (booleans).
- `merge`: optional object controlling merge methods and commit-message
  preferences.
- `security_and_analysis`: optional object controlling GitHub security
  features.

`settings.merge` accepts boolean `squash`, `merge_commit`, `rebase`,
`auto_merge`, and `update_branch`. It also accepts:

- `squash_commit_title`: `pull-request-title` or
  `commit-or-pull-request-title`.
- `squash_commit_message`: `pull-request-body`, `commit-messages`, or
  `blank`.
- `merge_commit_title`: `pull-request-title` or `merge-message`.
- `merge_commit_message`: `pull-request-title`, `pull-request-body`, or
  `blank`.

`settings.security_and_analysis` accepts `advanced_security`,
`code_security`, `secret_scanning`, `secret_scanning_push_protection`,
and `secret_scanning_ai_detection`. Each is `enabled` or `disabled`.
Availability and permissions depend on GitHub plans and repository settings.

`default_branch` is not always enforced on existing repositories. The root
`repositories.settings.default_branch_drift` policy controls that behavior;
see [default-branch handling](configuration.md#default-branch-and-automatic-initialization).

### `teams` and `custom_properties`

`teams` is an array of objects requiring `name` and `permission`. Built-in
permissions are `pull`, `triage`, `push`, `maintain`, and `admin`.
The user-friendly aliases `read` and `write` map to `pull` and `push`;
custom repository roles can be named too.

`custom_properties` maps GitHub custom-property names to a string, a list of
strings, or `null`. Property keys are preserved exactly.

```yaml
repository:
  teams:
    - name: platform
      permission: maintain
  custom_properties:
    workload: backend
    environments:
      - staging
      - production
```

### `actions`

The optional `actions` object supports:

- `enabled`: boolean.
- `allowed_actions`: `all`, `local_only`, or `selected`.
- `sha_pinning_required`: boolean.
- `selected_actions`: object with `github_owned_allowed`,
  `verified_allowed` (booleans), and `patterns_allowed` (unique list
  of non-empty strings).
- `oidc`: object with `immutable_subject` (boolean) and optional
  `subject_claim_template`. Its `source` can be `default`,
  `organization`, or `custom`; a custom source requires a non-empty
  unique `claims` array.
- `variables` and `secrets`: runtime bindings described below.

When any of `allowed_actions`, `sha_pinning_required`, or
`selected_actions` is present, `enabled: true` is required. When
`selected_actions` is present, a provided `allowed_actions` value must
be `selected`.

```yaml
repository:
  actions:
    enabled: true
    allowed_actions: selected
    selected_actions:
      github_owned_allowed: true
      verified_allowed: false
      patterns_allowed:
        - "actions/checkout@*"
    oidc:
      immutable_subject: true
```

### Runtime `variables` and `secrets`

The same binding shapes apply to `actions.variables`, environment variables,
`actions.secrets`, `dependabot.secrets`, and environment secrets.

A variable can be the name of an environment variable, a `from`/`to` rename,
or a literal `name`/`value` pair. A secret can be a name or a
`from`/`to` rename, but **cannot** be a literal value.

```yaml
repository:
  actions:
    variables:
      - REGION
      - from: SHARED_STAGE
        to: STAGE
      - name: BUILD_MODE
        value: release
    secrets:
      - DEPLOY_TOKEN
      - from: SHARED_TOKEN
        to: AUTOMATION_TOKEN
  dependabot:
    secrets:
      - NUGET_TOKEN
  environments:
    - name: production
      variables:
        - name: REGION
          value: eu-north-1
      secrets:
        - PROD_DEPLOY_TOKEN
```

The source name is resolved at runtime; `to` or `name` is the GitHub
destination. Secret contents are never placed directly in the YAML file.
Root secret policy and `--skip-missing-values` affect fresh operations; see
[runtime values](configuration.md#runtime-values) and
[secret reconciliation](configuration.md#secret-reconciliation).

### `rulesets`

Each ruleset object requires a unique `name`; other schema keys are optional:

- `target`: `branch`, `tag`, or `push`.
- `enforcement`: `disabled`, `evaluate`, or `active`.
- `bypass_actors`: array of `actor_type`, optional integer `actor_id`,
  and `bypass_mode`. Actor types: `integration`, `organization-admin`,
  `repository-role`, `team`, `deploy-key`, `user`. Bypass modes:
  `always`, `pull-request`, `exempt`.
- `conditions.ref_name.include` and `conditions.ref_name.exclude`:
  unique string lists identifying refs.
- `rules`: array of objects requiring `type` and optionally containing
  `parameters` (an object).

Supported `rules[].type` values from the schema:

```text
creation, update, deletion, required_linear_history, merge_queue,
required_deployments, required_signatures, pull_request,
required_status_checks, non_fast_forward, commit_message_pattern,
commit_author_email_pattern, committer_email_pattern,
branch_name_pattern, tag_name_pattern, workflows, code_scanning,
code_quality, code_coverage, copilot_code_review,
license_compliance_scanning, file_path_restriction,
max_file_path_length, file_extension_restriction, max_file_size
```

The schema accepts a generic `parameters` object; GitHub ruleset constraints
still apply at validation or execution. A ruleset inherited across fragments
cannot change from one explicit `target` to another under the same name.

### `environments`

An array of objects requiring `name`; each can have optional `variables`
and `secrets` lists using the binding shapes above. These entries merge by
environment name during document composition.

### `files`

A mapping from the **target repository path** to an instruction:

- `ensure: exact` requires `source` and manages the source content.
- `ensure: exists` requires `source` and creates a missing file without
  demanding exact content on existing files.
- `ensure: absent` declares explicit deletion and must not have `source`.

```yaml
repository:
  files:
    .github/CODEOWNERS:
      ensure: exact
      source: files/CODEOWNERS
    obsolete.txt:
      ensure: absent
```

`source` is resolved relative to the **control repository configuration
root**, even when the declaration came from a deeply nested fragment. This
differs from fragment `includes` paths, which are relative to the including
document. Source paths must remain within the configuration root. Files are
not implicitly deleted under `strict` collection management.

## Fragments and document composition

Fragments let several templates reuse one desired-state baseline without
copying it. They are separate YAML documents validated against
[`fragment.schema.json`](../schemas/fragment.schema.json), **not** partial
templates.

A fragment requires `version: 1`, `kind: fragment`, and
`resource: repository`. It must contain at least one of `includes` or
`repository`; it may contain both. It must not declare `match` or `name`.
A template requires `repository` even when it contains only `includes`.

Example layout:

```text
octosmith.yml
templates/
  services.yml
fragments/
  common.yml
  rules.yml
files/
  CODEOWNERS
```

`fragments/common.yml`:

```yaml
version: 1
kind: fragment
resource: repository

includes:
  - ./rules.yml

repository:
  settings:
    has_wiki: false
  teams:
    - name: platform
      permission: read
```

`fragments/rules.yml`:

```yaml
version: 1
kind: fragment
resource: repository

repository:
  settings:
    delete_branch_on_merge: true
  files:
    .github/CODEOWNERS:
      ensure: exact
      source: files/CODEOWNERS
```

`templates/services.yml`:

```yaml
version: 1
kind: repository

match:
  include:
    names:
      - "service-*"

includes:
  - ../fragments/common.yml

repository:
  settings:
    has_issues: true
  teams:
    - name: platform
      permission: maintain
    - name: developers
      permission: push
```

The effective repository has `has_wiki: false`, `has_issues: true`,
`delete_branch_on_merge: true`, the managed CODEOWNERS file, and exactly one
`platform` team entry with `maintain` permission plus the `developers`
entry. The template's team entry replaces the inherited one.

### Composition order and precedence

1. Follow the template's `includes` **in their listed order**.
2. For each fragment, recursively apply its own `includes` first, then its
   local `repository` content (depth-first).
3. Merge the template's local `repository` content **last**.
4. Object keys merge recursively. Later scalar values replace earlier values.
   Later declarations are therefore the overrides, not the first ones.

### Arrays and identity-aware overrides

**Arrays replace earlier arrays by default.** Octosmith opts these paths into
identity-aware merges:

- `teams`, `rulesets`, `environments`: key by `name`.
- `actions.secrets`, `dependabot.secrets`,
  `environments.*.secrets`: key by destination secret name.
- `actions.variables`, `environments.*.variables`: key by
  destination variable name.
- `rulesets.*.rules`: key by rule `type`.

For these collections, inherited entries retain their order, later matching
identities replace or enrich them as appropriate, and new identities append.
Matching `rulesets` and `environments` merge their **object fields**
recursively. Matching `teams`, secrets, and variables replace the **whole
entry**; rules with the same `type` replace their parameters atomically.
An explicit later empty array such as `teams: []` clears inherited entries.

Other arrays (such as `settings.topics`, OIDC `claims`, and
`rulesets.*.bypass_actors`) replace wholesale; YAML authors do not select
custom merge strategies. Objects such as `files` and `custom_properties`
merge by object key, with the later entry winning.

Duplicate identities **within one document** are invalid, even for nested
collections. Reusing the same identity **across different documents** is the
supported override mechanism. Explicitly conflicting ruleset `target` values
under one name are rejected instead of merged.

### Include paths, reuse, and safety

- Each include path is relative to the file **containing that `includes`
  entry**. A nested fragment resolves paths relative to itself, not the root
  template or the configuration directory.
- Include resolution uses canonical paths and rejects paths escaping the
  configuration root (including symlink escapes).
- Cycles are rejected, and nested includes are limited to **32 levels**.
- When the same canonical fragment is reached twice for one template, it is
  applied **once**, at its first depth-first occurrence. This matters for
  diamond-shaped include graphs and override order.
- Composition is independent per root template: multiple templates can reuse
  a fragment without sharing mutable merge state.
- Source documents are schema-validated before merging; the final effective
  repository is validated again after composition.

Inspect the resolved result without GitHub access:

```sh
octosmith template print services --path .
octosmith template print repository:services --path . --format json
octosmith template validate --path .
```

## Fallback templates

A fallback is an **ordinary repository template** selected for an in-scope
repository only if no template with `match` matches it. It is configured in
[`octosmith.yml`](root-configuration.md#template-selection), not by a flag
inside the template itself.

`octosmith.yml`:

```yaml
version: 1
organization: acme
repositories:
  scope:
    include: all
  settings:
    unmatched_repositories: fallback
    fallback_template: repository:baseline
```

`templates/baseline.yml`:

```yaml
version: 1
kind: repository

includes:
  - ../fragments/common.yml

repository: {}
```

A **fallback-only** template may omit `match`, as above; only the configured
fallback gets this exception. Alternatively, the fallback may have `match`
and act as a normal template for its matching repositories.

With this configuration:

- Exactly one explicit match → that template is used **without** merging the
  fallback.
- No explicit matches → `repository:baseline` is selected and reconciled
  normally, including its fragments.
- More than one explicit match → a validation/classification error; the
  fallback is not a tie-breaker.
- Outside root scope → unmanaged, never selected for fallback.

The fallback's `repository` object is **not** a default layer for every
template. To share a baseline with explicitly matched templates, include the
same fragments from those templates. A fallback that grants access or makes
collection removals under strict mode can affect many repositories; use
`octosmith resource list` and `octosmith plan` to review the selection
before applying it.

## Further reading

- [Root configuration file reference](root-configuration.md)
- [Configuration behavior](configuration.md): collection semantics, branch
  initialization, secret handling, file-delivery lifecycle.
- [CLI template commands](cli/template-commands.md)
- [Example configurations](../examples/configuration)
