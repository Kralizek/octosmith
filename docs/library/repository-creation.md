# Repository creation lifecycle

```ts
import {
  createRepository,
  FetchGitHubClient,
  LocalGitBootstrap,
  MissingRuntimeValueError,
  renderRepositoryCreationResult,
} from "jsr:@octosmith/octosmith@0";

const result = await createRepository({
  configuration: loaded, // Or a configuration directory path.
  template: "services",
  name: "api-service",
  visibility: "internal",
}, {
  client: new FetchGitHubClient({ token: Deno.env.get("GITHUB_TOKEN")! }),
  bootstrap: new LocalGitBootstrap({
    token: () => Deno.env.get("GITHUB_TOKEN")!,
  }),
  values: (name) => {
    const value = Deno.env.get(name);
    if (value === undefined) throw new MissingRuntimeValueError(name);
    return value;
  },
});
console.log(renderRepositoryCreationResult(result));
```

`RepositoryCreationRequest` and `RepositoryCreationResult` are reusable library
contracts. A lazy `client` factory can postpone authentication until preflight
succeeds. The bootstrap transport is checked before invoking that factory or
accessing GitHub; omitting it returns `preflight_rejected` without creating a
repository. The validated name is resolved once, checked remotely, then
submitted unchanged to the endpoint selected by the resolved owner type, with
only name, visibility and `auto_init: false`. Organizations continue to use
`POST /orgs/{owner}/repos`; the authenticated personal account uses
`POST /user/repos`. No README, license, Gitignore or commit is created. Required
teams/custom properties are assigned through the existing mutation sink and
actually re-read through discovery. Only an in-scope, unique match for the
explicitly selected template proceeds.

The owner is resolved through `GET /users/{configured-login}` and its canonical
login/type are reused through creation and verification. Personal owners must
match `GET /user`; repository discovery uses `GET /user/repos` and excludes
entries whose canonical repository owner differs. Team permissions and
organization custom properties fail preflight for personal owners.

Interactive hosts can first call `preflightRepositoryCreation` and resolve only
its structured ambiguities. Pass an effective pattern as
`RepositoryCreationInput.namingStrategy` to select the existing generator; the
library validates it against current effective constraints, never as an
arbitrary trusted pattern. See the
[preflight input contract](programmatic-api.md). After preflight succeeds, hand
`repository.name` and `repository.visibility` back as explicit creation inputs
with the same loaded configuration. Creation still re-runs authoritative
preflight before GitHub access, but does not generate another name. The CLI's
`--assisted` does this on an interactive terminal; strict library/CLI callers
remain noninteractive. No collision retry is added.

Creation reuses runtime-reference/secret policies, composed desired-state
resolution, `readCurrentState`, `buildPlan`, `applyPlan` and regular report
builders. The reusable `scope: "github-only"` option on the state reader,
planner/evaluations and mutation sink excludes GitHub file reads/delivery,
bootstrap operations and PR finishing without stripping files from desired
state. On empty history, default-branch changes, rulesets and archival
(`archived: true`) are deferred until Git bootstrap; API settings, teams,
properties, Actions, Dependabot and environments otherwise reconcile normally.
The result exposes safe deferred targets/reasons, not executable operations or
secret/file contents.

Configured deferred targets are recorded immediately after repository creation
so metadata, runtime-value and state-read failures preserve bootstrap recovery
information. Unarchiving remains applicable before bootstrap, and an
already-satisfied `archived: false` is not reported as deferred.

`RepositoryGitBootstrap` is an injectable library transport; `LocalGitBootstrap`
uses a temporary workspace, exactly one initial commit and at most one push. It
consumes `DesiredFile[]` from **the same `resolveDesiredState` transformation
used by ordinary reconciliation**, after template/fragment composition and
runtime preflight. There is no second file resolver. The composed
`repository.postCreateCommands` sequence is passed in `GitBootstrapRequest` and
runs only during actual creation, after Git initialization and identity setup,
before managed files. Declarative content overwrites generated files and
`ensure: absent` removes generated output. Generated files honor the final
`.gitignore`; explicitly managed files always enter the index. Raw Git blobs and
`write-tree`/`commit-tree` bypass attributes/filters and line-ending conversion
throughout staging and commit. No-files repositories receive an empty commit.
The commit identity is `Octosmith <octosmith@users.noreply.github.com>` for both
author and committer, and its message is `Initial repository bootstrap`.

Branch precedence is template `default_branch`, GitHub's organization/enterprise
default exposed as the new repository's `default_branch`, then documented
`main`. No extra organization API permission or invented branch policy is
needed. That resolved branch is explicitly pushed and configured as default.
Re-read classification/history/current state and a fresh `github-only` plan
finish default-branch settings and rulesets, with archival last. Successful API
deltas are not replayed; confirmed opaque secret deliveries still present
remotely are preserved within this invocation. Ordinary plan/apply defaults
remain unchanged.

The default HTTPS transport obtains a token lazily from the host, using a static
temporary askpass helper and an isolated push environment. It never writes the
token to disk or includes it in URLs/arguments. Raw Git diagnostics are captured
and discarded; configuration, prompts, inherited credential helpers, hooks and
global/system Git settings are isolated. POSIX uses a shell helper; native
Windows uses a `.cmd` helper invoking the system Windows PowerShell to read the
token directly from the environment, without expanding it into command text. The
static `x-access-token` username is configured locally so the Windows helper
only supplies the password. Git Contents: write and workflow authorization are
required independently of API creation permissions. Hosts can inject
authentication, Git execution and temporary-directory/cleanup services. Pass the
API `baseUrl` to `LocalGitBootstrap` when using GitHub Enterprise; the Git
remote uses that server's HTTPS origin rather than its `/api/v3` path.
`createGitHubRuntime` passes the same base URL to both API and Git transports.
Credential-bearing or non-HTTPS base URLs are rejected before Git execution.
Tests use fake execution or local bare repositories, never real GitHub creation.

`PostCreateCommand` is a narrow executable/optional-string-args configuration;
omitted `args` defaults to `[]`. Lists replace wholesale through existing
fragment composition. `LocalGitBootstrapOptions.runPostCreateCommand` injects a
runner receiving `PostCreateCommandInvocation` (`command`, literal `args`, root
`cwd`, isolated `env`); `runPostCreateCommand` is the native direct-execution
default. No shell, interactive stdin, implicit variable expansion, host
secret/environment injection, or retries are supplied. Output is captured, never
streamed. Hook programs are trusted, run with host privileges, and are not
sandboxed. The environment allows `PATH`, Windows `SYSTEMROOT`, private
home/temp directories, and bootstrap Git settings; the push token is obtained
only after commit and never reaches hook children. Generated paths use
managed-file safety checks; symlinks, special files, case collisions, and Git
aliases are rejected, while root `.git` internals are excluded. Commands must
not alter Git metadata. Ordinary desired-state resolution, planning, apply,
inspection, and validation do not execute or retain the hooks as managed
resources. See the
[template field reference](../repository-template.md#post_create_commands) and
[execution behavior](../configuration.md#create-only-bootstrap-commands).

Lifecycle statuses distinguish `preflight_rejected`, `name_collision`,
`creation_failed`, `metadata_failed`, `classification_failed`,
`reconciliation_failed`, `bootstrap_failed`, `bootstrapped_not_reconciled`, and
`completed` (`awaiting_bootstrap` remains a legacy status in the type).
Completed stages, failed stage, metadata assignment outcomes and the URL are
preserved when available. Reports exist only after normal reconciliation is
attempted. Repositories are never automatically deleted. Metadata/classification
failures may leave repositories outside discovery scope and require manual
repair; verified repositories can recover through ordinary plan/apply after
content and default-branch verification. `bootstrap` separately reports branch,
staged file count (including generated files), preparation, commit creation/SHA,
push attempt/confirmation, safe failure category, and cleanup failure.
`post_create_command` includes only the one-based `failedCommand` ordinal for
launch/nonzero failures; subsequent hooks, materialization, staging, and push
stop immediately. Arguments and subprocess output never enter reports. Workspace
cleanup still runs, but external side effects cannot be rolled back; repair and
initialize the retained repository manually, then use ordinary plan/apply, never
retry create. `push_unknown` explicitly means remote changes may have occurred.
`deferredReconciliationAttempted` and `deferredReport` distinguish successful
content delivery from complete creation. Never rerun create for a retained
repository; inspect uncertain pushes against the SHA, repair content manually if
needed, then create a fresh ordinary plan. See the
[CLI recovery guidance](../cli/resource-commands.md#resource-create).

`requiredPermissionsForRepositoryCreation` separates creation authorization,
selector metadata and API reconciliation permissions, without changing ordinary
permission analysis. See the
[permission guide](../automation.md#repository-creation-permissions).

For deeper guidance, see the repository documentation for
[configuration](../configuration.md) and [architecture](../architecture.md).

Canonical JSON Schemas for configuration authors are published from the
repository [`/schemas`](../../schemas/) directory. See the
[configuration guide](../configuration.md) for editor integration.
