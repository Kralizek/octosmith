# Programmatic API

## Import

```ts
import {
  buildPlan,
  buildRepositoryCreationPreview,
  loadConfigurationDirectory,
  preflightRepositoryCreation,
  renderRepositoryCreationPreview,
  validateConfigurationDirectory,
} from "jsr:@octosmith/octosmith@0";
```

For example, validate a configuration directory without accessing GitHub:

```ts
await validateConfigurationDirectory("./configuration");
```

Prepare a repository creation without GitHub access or mutations:

```ts
const loaded = await loadConfigurationDirectory("./configuration");
const specification = await preflightRepositoryCreation(loaded, {
  template: "services",
  name: "api-service",
});
const preview = buildRepositoryCreationPreview(loaded, specification);
console.log(renderRepositoryCreationPreview(preview));
// Or serialize the same typed projection for automation:
console.log(JSON.stringify(preview));
```

`RepositoryCreationSpecification` is the validated input shared by preview and
execution. `buildRepositoryCreationPreview` takes that specification and the
**same loaded configuration** and projects the existing composed template
(fragments included) into a versioned `RepositoryCreationPreview`. It does not
re-run name generation, selectors, or classification, create another
desired-state model, or plan against fictitious current state. Keep the
specification as diagnostic output; the preview is a safe reporting projection,
not an executable plan. Each creation operation runs authoritative preflight,
even when its host already resolved choices interactively.

The builder and separate text renderer do not access GitHub, credentials,
runtime value providers, Git, or the filesystem. Preflight still performs normal
offline validation, including checking local managed-file sources. Preview
exposes paths and presence/absence, never file contents or variable/secret
values. Resource summaries describe resolved configured intent, not exact API
deltas; unconfigured categories are `not_applicable`. Name availability, remote
classification verification, precise reconciliation, and runtime values are
deferred. Template-managed default branches resolve offline; otherwise execution
must consult the organization default and then GitHub's documented fallback.
Generated preview names are provisional, unreserved, and never persisted;
callers must explicitly supply a name to preserve it across separate
invocations.

Failed preflight specifications produce an unresolved preview with the original
structured choices, diagnostic codes, and validation details, and no bootstrap
or resource plan. Hosts should return failure when `preview.ready` is false. The
CLI performs end-to-end creation without `--dry-run`. Preview includes ordered
executable names/count for `repository.post_create_commands`, never arguments;
it never probes or runs them. The version 1 bootstrap projection adds
`postCreateCommands` (ordered `{ command }` summaries) and
`postCreateCommandCount`. Generated file counts remain unknown until execution;
the preview's file count covers declarative present files only. See the
[repository creation lifecycle](repository-creation.md) for command execution
and runner injection.

`RepositoryCreationInput.namingStrategy` accepts an exact pattern from the
current effective `choices.name.alternatives`. Preflight checks membership in
the fully analyzed intersection; arbitrary or stale patterns produce
`invalid_name_strategy`. Incomplete or unsafe strategy analysis offers no
selectable alternatives. Selecting a strategy reuses the ordinary secure
generator, bounded attempts, exclusions and unique classification checks; it
never trusts a caller-supplied generation pattern. An explicit `name` takes
precedence over generation.

Hosts may collect ambiguous visibility, naming-strategy or required-name choices
and re-run preflight with those inputs. Never prompt around unrelated semantic
errors. After a ready result, preserve `specification.repository.name` and
`visibility` as explicit inputs to `createRepository`, using the same loaded
configuration. Do not rely on a previously generated name being generated again.
The CLI implements this workflow with opt-in `resource create --assisted`; the
library itself never prompts.

## Main API areas

The package's default export surface includes:

- configuration loading and offline validation
- selector matching and desired-state resolution
- desired/current state models
- plan construction and operation types
- structured reports and text rendering
- GitHub discovery and state readers
- GitHub mutation sinks and apply helpers
- resource inspection and template classification
- worst-case GitHub permission analysis
- persisted-plan creation, validation, and preflight helpers

The package intentionally contains the reusable engine. CLI argument parsing,
console output selection, and Hooksmith event serialization live in
`@octosmith/cli`.

## Scaffold a control repository

The package also exposes `./create` for `deno create`:

```sh
deno create jsr:@octosmith/octosmith@0 github-config -- --organization acme
```

Useful options are:

- `--collection-management <explicit|strict>`
- `--default-branch <name>`
- `--no-workflows`
- `--event-streaming`

The generated repository starts scoped to itself so the initial apply cannot
unexpectedly manage an entire organization. Its README includes the current
`template validate`, `template permissions`, `resource list`, `plan`, and
`apply` workflows, including template-scoped plan/apply examples.

`include` is required and may be either a selector or the literal `all`. Use
`include: all` when the scope starts from every resource and only `exclude`
narrows it.
