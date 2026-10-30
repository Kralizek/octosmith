# Octosmith E2E Acceptance Report

**Run date:** 2026-10-30\
**Acceptance target:** GitHub repository creation from epic #17 and issues
#108–#113\
**Current overall result:** **Full Octosmith CLI create → bootstrap → reconcile
→ subsequent plan/apply lifecycle passed for successful scenarios against the
authorized `grupify` organization. The workflow-file push remains blocked by
missing `Workflows: write`; expected failure and recovery scenarios behaved
safely.**

## Latest continuation: full CLI against `grupify`

This is the current authoritative acceptance result and supersedes the earlier
personal-account limitation for the full lifecycle. The authorized `grupify`
target is an organization, unlike the personal account used in the prior
continuation. Every repository below was created by Octosmith's actual
`resource create` CLI; no `gh repo create` or direct `LocalGitBootstrap` call
was used for this organization run.

The CLI completed creation, classification, Git bootstrap, and immediate and
deferred reconciliation for A-core, B, C, D, both E variants, and the assisted H
case. Later ordinary CLI plan/apply was also run. A separate workflow fixture
reached the real Git push and failed with `push_rejected`: the current token
does not have the additional `workflow` scope required to create
`.github/workflows/*`. F and G intentionally failed before pushing content; F
was then recovered with ordinary CLI `plan` and `apply`. All ten created
organization repositories are private, use the `octosmith-e2e-` prefix, and
remain in place. No repository was deleted.

### Organization and permission verification

| Check                                          | Result                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated user                             | `Kralizek` (`type: User`)                                                                                                                                     |
| Organization                                   | `grupify` (`type: Organization`)                                                                                                                              |
| Membership                                     | Active, `admin` role                                                                                                                                          |
| Organization default repository permission     | `read`                                                                                                                                                        |
| `members_can_create_repositories`              | `true`                                                                                                                                                        |
| `members_can_create_private_repositories`      | `true`                                                                                                                                                        |
| `members_can_create_public_repositories`       | `true`                                                                                                                                                        |
| Actual private repo creation through Octosmith | Passed for all successful scenarios                                                                                                                           |
| Repository-scoped settings                     | Description, `has_issues`, and default branch updates succeeded on test repos                                                                                 |
| Repository Actions variables                   | Four synthetic values created and re-read for E-replace                                                                                                       |
| Workflow file push                             | Blocked: `Workflows: write` required but `gh auth status` reports only `repo`, `read:org`, and `admin:public_key` among the shown scopes; no `workflow` scope |
| Organization rulesets visibility               | Not verifiable with current token: `GET /orgs/grupify/rulesets` reported missing `admin:org`. No organization ruleset or setting mutation was attempted.      |

`deno run -A packages/cli/mod.ts template permissions a-workflow --creation
--format json --path /tmp/octosmith-e2e-grupify-20261030`
reports repository `administration: write`, selector metadata `read`, Git
bootstrap `contents: write`, and `workflows: write`. The account's active
org-admin membership and org create flags were verified separately. Actual
A-core creation, metadata updates, branch update, and other repository file
pushes succeeded, confirming the relevant current create/settings/content
permissions.

### Toolchain and source revision

| Item                                                | Observed                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Octosmith source revision tested                    | `1bac1cbe4d5779519dee0ae0cf216b1d4f7af880` (`master`, includes merge commit #123); report-only PR changes do not alter source      |
| Working PR branch before this report update         | `report/e2e-acceptance-20261030`, head `82b4a37333df7b36f8f8fa2ec71508dd89667601`                                                  |
| OS                                                  | Linux x86_64, WSL2 kernel `6.18.54.1-microsoft-standard-WSL2`                                                                      |
| Deno / Git / GitHub CLI                             | Deno `2.9.7` stable / Git `2.55.0` / `gh` `2.102.0`                                                                                |
| CLI invocation                                      | `deno run -A packages/cli/mod.ts resource create ...` from the checked-out source                                                  |
| Existing local validation at tested source revision | `deno task check`: schema sync, formatting, lint, documentation checks, 1041 tests passed / 0 failed; OpenCLI contract tests 10/10 |

### Isolation and exact scope

The isolated organization configuration is
`/tmp/octosmith-e2e-grupify-20261030/octosmith.yml`:

```yaml
version: 1
organization: grupify
repositories:
  scope:
    include:
      names: ["octosmith-e2e-*"]
      visibility: private
  settings:
    unmatched_repositories: ignore
  file_changes:
    mode: direct
```

Each template has an exact-name selector within this prefix. Every intended name
was queried and verified unused immediately before its actual CLI create. An
out-of-prefix name was rejected at preflight as `metadata_outside_intersection`.
The final actual CLI `resource list` returned exactly **10 matched, 0 fallback,
0 unmatched** resources. The GitHub org inventory query returned exactly these
ten private prefixed repositories; no assisted-alpha repository exists.

### Actual CLI creation results

| Scenario                                                         | Actual CLI result                                                                                                                                                                                                                                                                                                                               | Remote URL and initial history                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-core — declarative files without workflow                      | **PASS.** `resource create a-core` returned `completed`; created metadata, `main`, 10 managed files, one bootstrap push, successful deferred branch reconciliation.                                                                                                                                                                             | [A-core](https://github.com/grupify/octosmith-e2e-20261030-a-core), root commit `e91ecbdce6381f02976576e000893eb854c7fc3c`                                                   |
| A-workflow — workflow permission probe                           | **BLOCKED by credential scope.** `resource create a-workflow` created the private repo and reconciled description; local bootstrap prepared one commit and attempted push, then returned `bootstrap_failed`, stage `git_bootstrap`, reason `push_rejected`. No branch or remote commit exists. No raw Git diagnostic or credential was exposed. | [A-workflow](https://github.com/grupify/octosmith-e2e-20261030-a-workflow), no branches/commits; remote default still `master`                                               |
| B — generated files                                              | **PASS.** `resource create b-generated` returned `completed`; generator commands ran in order and 8 initial tracked files were bootstrapped. Later CLI plan/apply added one desired file; final plan is clean.                                                                                                                                  | [B](https://github.com/grupify/octosmith-e2e-20261030-b-generated), initial `702b4486129b0a485032f3e0895fc9bc1d080a67`; later `8cfde9d3eeac4c25cf4e3448092f3c73d2ffe015`     |
| C — generated/declarative collisions                             | **PASS.** `resource create c-collisions` returned `completed`; 9 files in one root commit, including declarative precedence and absent/ignored rules. Subsequent plan and apply unchanged.                                                                                                                                                      | [C](https://github.com/grupify/octosmith-e2e-20261030-c-collisions), root `512e1f3fb33ad297f437cf5f0b4fa969c1a9063d`                                                         |
| D — empty content                                                | **PASS.** `resource create d-empty` returned `completed`; created exactly one empty root commit on `main`; subsequent plan/apply unchanged.                                                                                                                                                                                                     | [D](https://github.com/grupify/octosmith-e2e-20261030-d-empty), root `11f4a3adef39de12dfae360db805c1182c1043d8`                                                              |
| E-replace — two fragments, root override and command replacement | **PASS.** `resource create e-replace` returned `completed`; composed files and Actions-variable collections reconciled; command list was replaced by the template list. Subsequent plan is clean.                                                                                                                                               | [E-replace](https://github.com/grupify/octosmith-e2e-20261030-e-replace), root `b3e15c261eab243270c66ade38579cf043fe255c`                                                    |
| E-clear — explicit empty command array                           | **PASS.** `resource create e-clear` returned `completed`; fragments composed and `post_create_commands: []` cleared inherited commands. Subsequent plan is clean.                                                                                                                                                                               | [E-clear](https://github.com/grupify/octosmith-e2e-20261030-e-clear), root `a8ee3bc35886872c044560f41135c2080f0ecfb4`                                                        |
| F — failed command and recovery                                  | **PASS for failure/recovery behavior.** Actual `resource create` retained the private repo, reported `bootstrap_failed`, `post_create_command`, ordinal `#1`, and no commit/push; later command did not run. Ordinary CLI plan identified initialization/file/cleanup; ordinary CLI apply completed those; final plan was unchanged.            | [F](https://github.com/grupify/octosmith-e2e-20261030-f-failure), recovery commits `8e7e913935f7623c8dd036598f98419ca8ecd626` and `49fbdcf47cc927ceb80072cee304547b351064f0` |
| G — unsafe generated Git-internal alias                          | **PASS for safe refusal.** Actual `resource create` created the repo and applied its repository description, then returned `bootstrap_failed`, `invalid_files`; no commit, push, or remote branch.                                                                                                                                              | [G](https://github.com/grupify/octosmith-e2e-20261030-g-unsafe), empty remote                                                                                                |
| H — assisted naming                                              | **PASS.** A local PTY selected option 2; CLI presented and created that same resolved name. Actual lifecycle returned `completed` and bootstrapped one empty root commit. PTY `:cancel` created no alpha repo.                                                                                                                                  | [H-beta](https://github.com/grupify/octosmith-e2e-20261030-h-assisted-beta), root `62ac54610a5f525920e196e280f27ea957649d92`; H-alpha absent                                 |

The pre-existing-name collision check ran actual
`resource create c-collisions --name octosmith-e2e-20261030-c-collisions` after
the repository existed. It returned `name_collision` before any mutation and
stated that no repository was created or adopted. Strict ambiguous naming
without `--assisted` returned `preflight_rejected`. Assisted mode with JSON,
dry-run, and non-TTY inputs was rejected before mutation. No PRs were opened for
any repository.

### Preview consistency

Previews used the same isolated config and source CLI. B JSON preview ran while
its selected repo name was still unused and resolved the same explicit identity
(`grupify/octosmith-e2e-20261030-b-generated`), private visibility, branch
`main`, `.gitignore`, and two ordered commands later reflected in actual
creation. Its preview said no repository was created and no command executed. E
JSON preview resolved five declarative files plus the template replacement
command; actual E-replace had those five effective declarative files plus only
the replacement command's generated file. E-clear JSON preview had four
declarative files and zero commands; actual E-clear had exactly that effective
file set and no generator-created output. A text and JSON preview both resolved
the same A-core identity/private visibility and ten planned files as the
successful actual A-core creation. Preview output omits file contents and
command arguments.

### Independent verification: bytes, modes, history and reconciliation

GitHub API queries and fresh clones independently verified visibility, default
branch, branch head, commit parentage, tree entries, blob bytes, Actions
variables, and PR count. Every successful initial bootstrap listed below is one
parentless `Initial repository bootstrap` commit. B has one additional expected
ordinary reconciliation commit; F has two commits only because ordinary recovery
runs initialization then managed-file delivery.

- **A-core exact contents:** all ten remote SHA-256 values match source fixture
  hashes. Examples: README
  `ed1bd60c01ab719cb76ab1d0a445f28ce830cbe7e8f2904cec1f5d402dc87fb5`, nested
  JSON `fb47d7bc8471061129cde2350a10791ad628eb9a58a830f3f0d0bd5b3afbda83`,
  `filename with spaces.txt`
  `f63f9d7dc8573b19cff42d53b01063c1b02dcaa517b23c5599079ad6b6e15faa`,
  `-leading.txt`
  `eeb6ed51ba299816fa1dd7968263d1d9026dd17b30d8c59eca3a5eca749c2b18`, UTF-8
  `16ed4eebde440dc0ba8cc982fb06ecab26346bd7fc0881fbf4f72af6bc9638ff`,
  no-final-newline
  `e06d68ba55c36d52fcc37043631be324050b3249873cf53ea96900c132058385`, and CRLF
  `98ab4d3aeab1e120560e942e2df6a0db1147bf94bafcf1590000ffb3c2b6fc80`.
- **B generator:** fresh clone shows `order.txt` exactly `first\nsecond\n`; root
  and nested files; UTF-8 file; `binary.dat` SHA-256
  `801e856b1349a0dca69f3df3f8ae7076df76c863de2b5c6356b9985f0185a6de`, matching
  bytes `00 01 02 ff 00 80`; generated CRLF bytes remain `0d 0a`; executable
  script mode is `100755`; ignored generated file is not in the tree. The later
  managed-file update produced the second commit whose parent is the bootstrap
  commit. A temporary sentinel post-create command was added to config after
  creation; ordinary apply remained unchanged and the sentinel output was
  absent, proving commands are not rerun by normal apply.
- **C precedence:** one initial tree contains `.editorconfig`, `.gitattributes`,
  `.gitignore`, README, `crlf.txt`, executable script, declarative
  `existing.txt`, generated-only file, and managed-ignored file. Declarative
  README and editorconfig blob hashes match their source; the `ensure: exists`
  file matches declarative bytes. `remove-me.txt`, `nested/remove.txt`, and
  ignored `ignored.txt` are absent. Explicitly managed `managed-ignored.txt`
  remains tracked despite `.gitignore`. `.gitattributes` specifies text/EOL and
  a synthetic clean filter for `crlf.txt`; a fresh clone configured with a local
  `tr a-z A-Z` clean filter produces hypothetical object ID
  `683418e7682e7b86ba4ea84ff1f5deea83561e0f`, while the remote raw blob is
  `4a046735c88b47e53f3414069c394a8fe378a825` and its actual bytes retain CRLF.
  The synthetic filter was local-only and not pushed.
- **D empty tree:** `main` has only commit
  `11f4a3adef39de12dfae360db805c1182c1043d8` with no parents; tree ID is the
  canonical empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`; zero blobs.
- **E effective collection composition:** GitHub Actions variable reads for
  E-replace returned `BASE_ONLY=base`, `SECOND_ONLY=second`,
  `SHARED_VALUE=template-wins`, and `ROOT_ONLY=root`. E-clear contains only the
  inherited `BASE_ONLY`, `SECOND_ONLY`, and `SHARED_VALUE=fragment-base`; it has
  no template-only `ROOT_ONLY`. Both repositories have the effective fragment
  files and root override; E-replace alone has `command-replacement.txt`;
  neither contains inherited command output.
- **F recovery:** final history has root
  `8e7e913935f7623c8dd036598f98419ca8ecd626`
  (`Octosmith: initialize
  repository`) and child
  `49fbdcf47cc927ceb80072cee304547b351064f0`
  (`Octosmith: reconcile managed files`). The tree contains only `recovery.txt`;
  later-command marker is absent. Final targeted CLI plan is clean.
- **A-workflow/G failure remotes:** independently queried branch lists are
  empty; no initial content was pushed. A-workflow's local attempted commit SHA
  in the CLI result was `3f1bf630933740c8f307022899d97f2cccfcece5`; it is not
  present remotely.
- **Settings:** GitHub API confirms A-core private, `main`, intended
  description, and `has_issues: false`. E repositories similarly accepted their
  repo-specific description, `has_issues: false`, and deferred
  `default_branch: main`; Actions variables were reconciled successfully. These
  are repository-scoped settings only.

### Result and remaining limitation

The full CLI lifecycle is now demonstrated against a real GitHub
**organization** for A-core, B, C, D, E-replace, E-clear, and assisted H: create
→ classify → repository API reconciliation → one initial Git commit/push →
deferred reconciliation → clean subsequent plan/apply. B also passed a later
file change. F proves ordinary recovery after bootstrap failure. G and the
workflow test prove safe pre-push/local bootstrap refusal paths. Scenario A's
separate workflow file remains blocked only on `Workflows: write`, not
repository creation or ordinary `Contents: write`. No implementation defect was
reproduced in these runs.

**Operational conclusion:** core organization repository creation is now
operationally verified for the exercised supported paths. Do not claim the
workflow-file path is verified for the current credential until an authorized
token with `Workflows: write` can be used to rerun A-workflow. Organization
rulesets could not be enumerated due missing `admin:org` credential scope; no
org-wide settings or rulesets were changed.

### Organization test resource inventory

All ten repositories below are private, in `grupify`, with the exact prefix. No
PRs exist. A-workflow and G have empty Git remotes after intended failures. No
repository was deleted.

| Repository                                                                           | Final state                                                                               | Manual cleanup    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------- |
| [A-core](https://github.com/grupify/octosmith-e2e-20261030-a-core)                   | `main`, one root commit, 10 files, clean plan                                             | Operator decision |
| [A-workflow](https://github.com/grupify/octosmith-e2e-20261030-a-workflow)           | Empty remote after rejected workflow push                                                 | Operator decision |
| [B-generated](https://github.com/grupify/octosmith-e2e-20261030-b-generated)         | `main`, initial + one later file-reconciliation commit, 9 files, clean plan               | Operator decision |
| [C-collisions](https://github.com/grupify/octosmith-e2e-20261030-c-collisions)       | `main`, one root commit, 9 files, clean plan                                              | Operator decision |
| [D-empty](https://github.com/grupify/octosmith-e2e-20261030-d-empty)                 | `main`, one empty root commit, clean plan                                                 | Operator decision |
| [E-replace](https://github.com/grupify/octosmith-e2e-20261030-e-replace)             | `main`, one root commit, composed files and four Actions variables, clean plan            | Operator decision |
| [E-clear](https://github.com/grupify/octosmith-e2e-20261030-e-clear)                 | `main`, one root commit, composed files and three inherited Actions variables, clean plan | Operator decision |
| [F-failure](https://github.com/grupify/octosmith-e2e-20261030-f-failure)             | `main`, recovered with two commits and one managed file, clean plan                       | Operator decision |
| [G-unsafe](https://github.com/grupify/octosmith-e2e-20261030-g-unsafe)               | Empty remote after generated Git-internal path refusal                                    | Operator decision |
| [H-assisted-beta](https://github.com/grupify/octosmith-e2e-20261030-h-assisted-beta) | `main`, one empty root commit, clean apply                                                | Operator decision |

H-assisted-alpha was not created. The final organization inventory query
returned exactly these ten `octosmith-e2e-*` repositories. Previous
personal-account test repositories from the historical continuation remain
separate under `Kralizek`; they are not included in this organization inventory.

## Previous continuation: personal-account component testing

The following sections preserve the earlier `Kralizek` user-account run as
historical context. They are not the current organization-run result. authorized
personal account `Kralizek`, using only private repositories named with the
`octosmith-e2e-` prefix. Nine new repositories were created and none were
deleted.

The critical limitation was discovered by executing the source CLI: Octosmith's
creation and discovery APIs call organization-only endpoints such as
`POST /orgs/{owner}/repos` and `GET /orgs/{owner}/repos`. GitHub identifies
`Kralizek` as a **user**, not an organization. The actual `resource create`
attempt therefore failed with HTTP 404 before creating a repository, and
ordinary CLI `plan` failed at organization discovery. The CLI has no personal
account repository-creation path.

To continue testing instead of stopping there, the empty private test
repositories were provisioned with `gh repo create` after checking every name
was unused. The source `LocalGitBootstrap` was then run directly against those
empty remotes, and the reusable Octosmith state reader/planner/apply engine was
run against the individual test repositories. This verified real pushes, commit
history, blobs, modes, command behavior, failure handling, and recovery. **These
results are not represented as full `resource create` CLI E2E passes.**

### Previous run: safety and scope

- Target identity was explicitly confirmed as `Kralizek` (`gh api user` returned
  `type: User`). The synthetic `acme` fixture owner was not used for any GitHub
  request.
- The isolated configuration is under `/tmp/octosmith-e2e-20261030`, outside the
  Octosmith source tree.
- Root repository scope is exactly `names: ["octosmith-e2e-*"]` **and**
  `visibility: private`. Each test template further matches its exact scenario
  repository name. An out-of-prefix create request was rejected in preflight
  with `metadata_outside_intersection`.
- All nine intended repository names were checked as unused before creation.
  Final account inventory found exactly those nine new prefix-matching
  repositories; assisted alpha/beta names remain absent.
- All created test repositories are private. No unrelated repository was
  changed, no organization-wide setting was changed, and no test repository was
  deleted. E-template repository settings affected only E test repos.
- All GitHub credentials were obtained by the CLI/library from `gh` and were
  never printed or written into the report, manifest, or execution log.
- No organization-wide `apply` was run. No bootstrap or later pull request was
  created; every test repository has zero PRs.

### Previous run: environment

| Item                   | Observed                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Tested source revision | `1bac1cbe4d5779519dee0ae0cf216b1d4f7af880` (`master`, includes merge commit #123)        |
| OS                     | Linux x86_64, WSL2 kernel `6.18.54.1-microsoft-standard-WSL2`                            |
| Deno                   | `2.9.7` stable                                                                           |
| Git                    | `2.55.0`                                                                                 |
| GitHub CLI             | `2.102.0`                                                                                |
| Octosmith CLI          | Source entry point `packages/cli/mod.ts`, version `0.1.0`                                |
| Authenticated identity | `Kralizek`; GitHub reports account type `User`                                           |
| Reported token scopes  | `admin:public_key`, `gist`, `read:org`, `repo`; no `workflow` or `admin:org` scope shown |

The root `deno task check` passed on the source revision: schema sync,
formatting, lint, documentation checks, and **1041 tests passed / 0 failed**.
The targeted OpenCLI contract test passed **10 / 10**. The report was formatted
and the check is rerun before updating this PR.

### Previous run: personal-account support limitation

Evidence collected:

1. `gh api user --jq '{login,type}'` returned
   `{"login":"Kralizek","type":"User"}`.
2. `gh api orgs/Kralizek` returned HTTP 404.
3. Before manually creating repository B, the source CLI ran:

   ```text
   deno run -A packages/cli/mod.ts resource create b-generated \
     --name octosmith-e2e-20261030-b-generated --visibility private \
     --path /tmp/octosmith-e2e-20261030 --format json
   ```

   The name was checked unused immediately beforehand. Octosmith reported
   `status: creation_failed`, `failedStage: creation`, `httpStatus: 404`; the
   repository remained absent. The sanitized message was:
   `GitHub API request failed (HTTP 404); check authentication, permissions, organization policy and request constraints.`
4. Source `createOrganizationRepository` posts to `/orgs/{organization}/repos`.
   The source CLI `plan` independently failed at `GET /orgs/Kralizek/repos` with
   HTTP 404.

This is a confirmed limitation for the requested personal-account target, not a
simulated failure. `gh repo create` can create the authorized personal
repositories, which allowed the lower-level bootstrap and state engine to be
tested against actual remote repositories.

### Previous run: local configuration, previews, and execution method

The isolated root config contains:

```yaml
organization: Kralizek
repositories:
  scope:
    include:
      names: ["octosmith-e2e-*"]
      visibility: private
```

Every template has an exact test-name selector. Text and JSON offline previews
for A–E and the declarative supplement resolved the same identity, private
visibility, branch, composed managed-file intent, and command count. Previews
reported that they did not create repositories or execute commands; command
arguments and file content were not displayed. The automatic single-pattern
preview resolved only the synthetic `octosmith-e2e-` name. The strict ambiguous
H preview returned an ambiguity diagnostic instead of prompting.

After empty remote provisioning with GitHub CLI, the test harness imported the
repository's actual source implementations:

- `loadConfigurationDirectory` and `resolveDesiredState`
- `LocalGitBootstrap.bootstrap` (including a live remote-empty assertion)
- `GitHubRepositoryStateSource` and `readCurrentState`
- `buildPlan`, `applyPlan`, `GitHubRepositoryMutationSink`, and
  `GitHubRepositoryBootstrap` for reconciliation and recovery

All bootstrap pushes used the implementation's normal isolated Git workspace,
credential handling, staging, commit, and push logic. This bypassed only the
unsupported **repository creation/discovery endpoint**, not file materialization
or bootstrap logic. Logs and manifest are in the isolated temporary workspace:
`/tmp/octosmith-e2e-20261030/execution.log` and `manifest.json`.

### Previous run: scenario results

| Scenario                              | Expected behavior                                                                                                          | Actual behavior and status                                                                                                                                                                                                                                                                                                                               | GitHub repository                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A — full declarative template         | Private repo; 11 declarative files including workflow; exact/exists; one initial commit                                    | **BLOCKED / partial attempt.** CLI creation cannot create a personal-account repo. Direct bootstrap prepared 11 files and one local root commit, but push was rejected. Remote remains empty. Permission report requires `Workflows: write`; current token scopes do not include `workflow`.                                                             | [A — declarative](https://github.com/Kralizek/octosmith-e2e-20261030-a-declarative)           |
| A — declarative core supplement       | Exercise declarative exact/exists, byte-sensitive and portable paths without workflow permission                           | **PASS for bootstrap component.** Ten files pushed in one root commit; exact bytes verified independently. Follow-up plan was clean. Repo was manually provisioned because CLI creation is unsupported for this account.                                                                                                                                 | [I — declarative core](https://github.com/Kralizek/octosmith-e2e-20261030-i-declarative-core) |
| B — generated files                   | Ordered commands; root/nested/UTF-8/binary/CRLF/executable outputs; ignored output excluded                                | **PASS for bootstrap component.** Eight tracked initial files in one root commit; `order.txt` is `first` then `second`; ignored output absent; binary, CRLF, and executable mode verified. Later managed-file reconciliation added one file and converged.                                                                                               | [B — generated](https://github.com/Kralizek/octosmith-e2e-20261030-b-generated)               |
| C — generated/declarative collisions  | Declarative exact/exists overrides; absent removes generated; generated-only retained; ignore/attributes/raw bytes correct | **PASS for bootstrap component.** Nine tracked files in one root commit; exact and exists bytes match the declarative sources; absent and ignored outputs are missing; generated-only and explicitly managed ignored files are present.                                                                                                                  | [C — collisions](https://github.com/Kralizek/octosmith-e2e-20261030-c-collisions)             |
| D — empty content                     | One empty root commit, default branch, later reconciliation clean                                                          | **PASS for bootstrap component.** Exactly one parentless root commit on `master`; tree is empty; subsequent plan was clean.                                                                                                                                                                                                                              | [D — empty](https://github.com/Kralizek/octosmith-e2e-20261030-d-empty)                       |
| E — fragments and command replacement | Two fragments, template override, nested files, collection composition, replacement command list                           | **PARTIAL.** Seven effective files and replacement command output are in one initial commit. The two fragment team entries compose in order. Later team assignment hit an organization-only endpoint and returned 404 for the user account; file state was independently verified, but a clean full-resource plan is blocked by those team declarations. | [E — replacement](https://github.com/Kralizek/octosmith-e2e-20261030-e-replace)               |
| E — clear inherited commands          | `post_create_commands: []` clears both fragments' inherited command                                                        | **PARTIAL.** Five composed files are in one initial commit; no inherited or replacement command output exists. Team reconciliation is blocked by user-versus-organization semantics as above.                                                                                                                                                            | [E — clear](https://github.com/Kralizek/octosmith-e2e-20261030-e-clear)                       |
| Failed post-create command            | Command ordinal is reported, later command is skipped, remote stays empty; recovery path                                   | **PASS for bootstrap/recovery components.** Bootstrap failed at `post_create_command`, ordinal 1, with no commit or push. The retained empty repo was populated by ordinary engine plan/apply and converged. It was manually provisioned before the failure test.                                                                                        | [Failure/recovery](https://github.com/Kralizek/octosmith-e2e-20261030-f-failure)              |
| Invalid generated file                | Forbidden Git-internal alias rejected before commit/push                                                                   | **PASS for bootstrap component.** A generated `.GIT/unsafe.txt` resulted in `invalid_files`; no commit, push, or remote branch. A symlink-specific case was not needed for this Git-internal-path test.                                                                                                                                                  | [Unsafe path](https://github.com/Kralizek/octosmith-e2e-20261030-g-unsafe)                    |
| Existing-name collision               | Existing repository is not adopted or altered                                                                              | **PASS.** `resource create` reported `name_collision` and explicitly said no repository was created or adopted. The existing disposable repo remained private and branchless.                                                                                                                                                                            | [A — collision check](https://github.com/Kralizek/octosmith-e2e-20261030-a-declarative)       |
| Assisted creation                     | Interactive strategy choice, cancellation, no unsafe prompts or incompatible formats                                       | **PARTIAL.** A local PTY selected the beta strategy and Octosmith reported the same resolved repository name; the later create step failed at the personal-account endpoint and created nothing. PTY `:cancel`, non-TTY, `--format json`, and `--dry-run` restrictions all behaved safely. Assisted alpha/beta repos remain absent.                      | None created                                                                                  |
| CLI scope safety                      | Reject names outside disposable selector before mutation                                                                   | **PASS.** `outside-prefix-test` was rejected at preflight with `metadata_outside_intersection`; no API mutation.                                                                                                                                                                                                                                         | None created                                                                                  |
| CLI plan/discovery                    | Targeted normal CLI plan works on authorized account                                                                       | **BLOCKED by account type.** `plan` failed at organization repository discovery (`GET /orgs/Kralizek/repos`, 404). Per-repository source library read/plan/apply operations were tested where applicable.                                                                                                                                                | N/A                                                                                           |

### Previous run: independent remote evidence

GitHub API queries and fresh `gh repo clone` operations independently verified
private visibility, `master` as default branch, branch heads, commit ancestry,
trees/modes, and zero pull requests across all nine repositories.

### Commit graph and tree

| Repo      | Branch / commits                                                       | Commit evidence                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A         | `master` default configured, zero branches/commits after rejected push | No remote bootstrap was pushed                                                                                                                                                                                   |
| B         | `master`, 2 commits after normal follow-up change                      | `bd67c2d909e224e97be01fd0a70632fa38312f2d` is the parentless `Initial repository bootstrap`; `4b0109e3a61b25a17604bfac8a05b19492c2e02a` has exactly that parent and message `Octosmith: reconcile managed files` |
| C         | `master`, exactly 1 parentless commit                                  | `452d14f603bbb0484fa7643918d215b2c154d8da`                                                                                                                                                                       |
| D         | `master`, exactly 1 parentless commit, no blobs                        | `0d5a8cd8973a9b566fc1e80ca9fc5274bb7b4738`; empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`                                                                                                                |
| E-replace | `master`, exactly 1 parentless commit                                  | `23eccdb710769c14ef0e51bb9d871bfb849a2383`                                                                                                                                                                       |
| E-clear   | `master`, exactly 1 parentless commit                                  | `279ac1e8090d34032aae1e73a69ef0e7c41ec113`                                                                                                                                                                       |
| F         | `master`, 2 recovery commits; original failed bootstrap made no commit | `291c6d44cd84f5f018ea806e4a84617fa3bd4599` (`Octosmith: initialize repository`), then `e35dd933f00ee6037d209499c7da75115a059fae` (`Octosmith: reconcile managed files`)                                          |
| G         | Zero branches/commits after invalid-file refusal                       | No push attempted                                                                                                                                                                                                |
| I         | `master`, exactly 1 parentless commit                                  | `806b52278e17322135d99f9d3b6836b8f6370c24`                                                                                                                                                                       |

No test repo had an open or closed pull request.

### Exact bytes, ignore rules, and modes

- B initial tree has eight files: `.gitignore`, `generated-root.txt`,
  `nested/generated.txt`, `order.txt`, `utf8-generated.txt`, `binary.dat`,
  `crlf-generated.txt`, and executable `executable.sh` (`100755`). The ignored
  generated file is absent. `order.txt` contains `first\nsecond\n`.
- B remote `binary.dat` SHA-256:
  `801e856b1349a0dca69f3df3f8ae7076df76c863de2b5c6356b9985f0185a6de`, matching
  the expected bytes `00 01 02 ff 00 80`. Remote CRLF bytes are
  `alpha 0d 0a beta 0d 0a`.
- C's README, `.editorconfig`, `existing.txt`, and `managed-ignored.txt` remote
  blob SHA-256 values match their respective declarative source files:
  `b37a18201d471e42862b55b649bef83c6f3fc6d8c58037b06d5df171ff15bc04`,
  `7df74457f2e1882e3c45e1c7e201b7361bfaeb00046d372c486b977fc6114c48`,
  `5469c3c10261b608a8740057b4bd1396cfd1b8694d79884117319d912880e744`, and
  `b358a2c78b3718e5dcf9e78a1f23717ef57908cf883c7a255389a467bbedfc2b`. The
  generated README/settings/text lost to the declarative content.
- C's `remove-me.txt`, `nested/remove.txt`, and ignored `ignored.txt` are
  absent. `generated-only.txt` remains. `managed-ignored.txt` is matched by
  `.gitignore` but explicitly staged and present. `executable.sh` is mode
  `100755`.
- C's `.gitattributes` declares `*.txt text eol=lf` and
  `filter=octosmith-e2e-clean` for `crlf.txt`. A fresh clone's local-only test
  configured that clean filter as `tr a-z A-Z`: Git's hypothetical cleaned
  content hash was `683418e7682e7b86ba4ea84ff1f5deea83561e0f`, while the remote
  blob remains `4a046735c88b47e53f3414069c394a8fe378a825`. `git cat-file` showed
  the remote raw declarative bytes still contain CRLF (`0d 0a`). The clone-only
  filter config was not pushed or applied to GitHub.
- I's raw remote blob SHA-256 values exactly match the fixture sources:
  `no-trailing-newline.txt`
  `e06d68ba55c36d52fcc37043631be324050b3249873cf53ea96900c132058385`, `crlf.txt`
  `98ab4d3aeab1e120560e942e2df6a0db1147bf94bafcf1590000ffb3c2b6fc80`, `utf8.txt`
  `16ed4eebde440dc0ba8cc982fb06ecab26346bd7fc0881fbf4f72af6bc9638ff`,
  `filename with spaces.txt`
  `f63f9d7dc8573b19cff42d53b01063c1b02dcaa517b23c5599079ad6b6e15faa`, and
  `-leading.txt`
  `eeb6ed51ba299816fa1dd7968263d1d9026dd17b30d8c59eca3a5eca749c2b18`. The final
  byte dump confirms the no-newline file has no `0a` and the CRLF file contains
  `0d 0a`.

### Composition and reconciliation

- E effective resolution included both fragment file sets, the root template's
  `override.txt`, and the root nested path. The root override's SHA matches
  `files/e-template-override`; the fragment version did not win.
- E-replace resolved one root command, replacing the inherited fragment list;
  its generated `command-replacement.txt` is present and `must-not-exist.txt` is
  absent.
- E-clear resolved an empty command list; neither inherited nor replacement
  command output exists. Effective team arrays contain both synthetic fragment
  entries in order.
- B, C, D, and I subsequent library `readCurrentState/buildPlan/applyPlan`
  cycles had empty plans. B was then changed by adding
  `reconciled-after-bootstrap.txt`; Octosmith applied exactly one `create-file`
  operation, created the second commit, did not rerun creation commands, and
  returned an empty final plan.
- F bootstrap failure reported only `failure: "post_create_command"` and
  `failedCommand: 1`; the private sentinel argument and subprocess output were
  not reported. The remote remained branchless before recovery. Ordinary
  plan/apply then applied `initialize-repository`, `create-file`, and
  `cleanup-repository-bootstrap`, and the final plan was empty. The later
  command's marker is absent.
- E's ordinary plan attempted its repository setting update successfully, then
  team assignment returned 404 from the organization-only teams endpoint; the
  second assignment was skipped. No team was assigned, and the plan is not clean
  for those organization-only team declarations. No org-wide settings were
  modified.

### Previous run: findings

#### Confirmed product limitation

| Severity                       | Reproduction / sanitized result                                                                                                                                                                                                                                | Expected vs. observed                                                                                                                                                                                                           | Suspected component                                                                                               | Recommendation                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High for this requested target | Run the source CLI `resource create` with `organization: Kralizek` and an unused prefixed name; independently `gh api user` returns `type: User`. Result: `creation_failed`, stage `creation`, HTTP 404. `plan` fails at org repository listing with HTTP 404. | Expected: create/discover personal-account repositories, as authorized. Observed: Octosmith uses `/orgs/{owner}/repos` and `/orgs/{owner}/repos` discovery, which cannot address a user account. No repo is created by the CLI. | `createOrganizationRepository` and `discoverRepositories`; current CLI/library contract is organization-oriented. | Add explicit account/owner support with user-repository create and discovery endpoints, or run the full CLI acceptance against an authorized organization. Do not infer a production organization. |

#### Environment / permission limitations

| Severity | Reproduction / sanitized result                                                                                                                                                                                                                                                                                                             | Expected vs. observed                                                                                                  | Likely requirement                                                                         | Recommendation                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Scenario A `LocalGitBootstrap` prepared 11 files and a local root commit, then returned `push_rejected`; no branch or commit exists remotely. `template permissions a-declarative --creation` reports `Workflows: write`; current `gh auth status` scopes do not include `workflow`. Bootstrap deliberately suppresses raw Git diagnostics. | Expected: push workflow file in the initial commit. Observed: rejected push and no remote history.                     | GitHub workflow write authorization is separately required for `.github/workflows/ci.yml`. | Re-run A only with an operator-authorized credential carrying workflow-write permission. This will not resolve the personal-account `/orgs` endpoint limitation. |
| Medium   | E team reconciliation returned HTTP 404 from `/orgs/Kralizek/teams/...`; `Kralizek` is a user account.                                                                                                                                                                                                                                      | Expected: reconcile two declared teams. Observed: org-only team endpoint is inapplicable; no team assignment occurred. | Teams require a GitHub organization.                                                       | Use an actual authorized test organization for team-resource verification, or omit org teams for personal-account tests.                                         |

#### Confirmed defects

No defect was isolated in managed-file materialization, raw blob staging,
generated/declarative precedence, empty-root bootstrap, or tested recovery. The
full CLI workflow remains unverified because of the owner-type limitation; the
bootstrap/reconciliation results above are component-level live tests, not a
substitute for that missing full lifecycle.

### Previous run: resource inventory

All listed repositories are private, under `Kralizek`, and have the
`octosmith-e2e-` prefix. All require manual cleanup if the operator chooses;
none were deleted.

| Repository                                                                                    | Final state                                                           | Cleanup           |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| [A — declarative](https://github.com/Kralizek/octosmith-e2e-20261030-a-declarative)           | Empty; failed workflow-file push, no branch                           | Operator decision |
| [B — generated](https://github.com/Kralizek/octosmith-e2e-20261030-b-generated)               | `master`, two commits, nine files, clean plan, no PR                  | Operator decision |
| [C — collisions](https://github.com/Kralizek/octosmith-e2e-20261030-c-collisions)             | `master`, one root commit, nine files, clean plan, no PR              | Operator decision |
| [D — empty](https://github.com/Kralizek/octosmith-e2e-20261030-d-empty)                       | `master`, one empty root commit, clean plan, no PR                    | Operator decision |
| [E — replacement](https://github.com/Kralizek/octosmith-e2e-20261030-e-replace)               | `master`, one root commit, seven files; team reconcile blocked        | Operator decision |
| [E — clear](https://github.com/Kralizek/octosmith-e2e-20261030-e-clear)                       | `master`, one root commit, five files; team reconcile blocked         | Operator decision |
| [F — failure/recovery](https://github.com/Kralizek/octosmith-e2e-20261030-f-failure)          | `master`, recovered with two commits and one managed file; clean plan | Operator decision |
| [G — unsafe path](https://github.com/Kralizek/octosmith-e2e-20261030-g-unsafe)                | Empty; unsafe generated path rejected before push                     | Operator decision |
| [I — declarative core](https://github.com/Kralizek/octosmith-e2e-20261030-i-declarative-core) | `master`, one root commit, ten files, clean plan, no PR               | Operator decision |

No repository was created for assisted alpha/beta. The final account query found
exactly these nine prefixed repositories and no additional test resources.

### Previous assessment: personal-account run

1. **Can Octosmith create a repository end-to-end?** Not for the explicitly
   authorized personal user account. The source CLI create attempt failed at the
   organization-only creation endpoint. Lower-level Octosmith bootstrap passed
   after manual empty-repository provisioning.
2. **Does managed-file materialization work correctly?** The tested source
   bootstrap correctly materialized and pushed B, C, D, E, and I to real
   remotes. Full `resource create` integration remains blocked.
3. **Do generated files coexist correctly with declarative files?** Yes in C:
   declarative README/settings/exists content wins, absent files are removed,
   generated-only content remains, and managed ignored content is included.
4. **Are `exact`, `exists`, and `absent` handled correctly?** The remote
   bootstrap behavior passed for exact/exists in C and I, and absent in C and D.
   A's workflow-containing full remote commit remains blocked.
5. **Are `.gitignore` and `.gitattributes` honored as intended?** Yes for tested
   remote raw Git trees: ignored files are absent unless explicitly managed; the
   explicitly managed ignored file is present; raw CRLF survives text/EOL and a
   declared clean-filter attribute.
6. **Does initial bootstrap always produce one commit?** The successful
   component-level bootstraps B, C, D, E, and I produced exactly one parentless
   initial commit. A was push-rejected before remote commit; F/G intentionally
   failed before push. This does not establish every full CLI creation path.
7. **Is the created repository correctly reconciled afterward?** B, C, D, and I
   converged with clean plans; B accepted a later managed-file update. Failure
   repository F recovered cleanly. E's organization-only teams remain
   unreconciled on a user account.
8. **Are failure reports and recovery paths operationally usable?** The
   bootstrap safely reports the failed stage and command ordinal without
   exposing arguments/output; the retained empty repo was recoverable through
   Octosmith's plan/apply engine. Full CLI discovery still cannot target this
   user account.
9. **Does assisted mode work correctly?** PTY name selection and cancellation
   behaved safely, as did non-TTY, JSON, and dry-run rejection. The selected
   name reached the creation lifecycle unchanged, where the owner-type
   limitation stopped the operation. Visibility ambiguity and manual-name
   correction were not exercised because the safety config deliberately
   constrains visibility to private and provides explicit strategies.
10. **What blocks calling epic #17 operationally verified?** Full creation and
    discovery against the authorized user account are unsupported by the
    organization-only API paths. Workflow-write permission was also missing for
    A, and E team resources require an organization. A rerun against an
    explicitly authorized organization with suitable permissions—or
    implementation support for personal owners plus workflow authorization—is
    needed for full CLI acceptance.

**Recommendation:** The tested bootstrap, content precedence, raw file bytes,
single-root-commit behavior, and recovery path show strong component-level
results. Do **not** call epic #17 fully operationally verified or the complete
repository-creation CLI production-ready yet: the required end-to-end
create/discover/reconcile lifecycle could not be exercised through the CLI for
the authorized personal-account target.

## Current final assessment: organization CLI run

1. **Can Octosmith create a repository end-to-end?** Yes for the exercised
   private organization-repository paths: A-core, B, C, D, E-replace, E-clear,
   and assisted H completed actual `resource create`. The workflow fixture
   remains blocked on the token's missing workflow-write scope.
2. **Does managed-file materialization work correctly?** Yes. Independently
   cloned remote trees match the effective templates; B also accepted a later
   managed-file update through ordinary `apply`.
3. **Do generated files coexist correctly with declarative files?** Yes. C's
   declarative exact/exists content wins over generated collisions,
   generated-only content survives, and explicitly managed ignored content is
   committed.
4. **Are `exact`, `exists`, and `absent` handled correctly?** Yes for the
   exercised files: C verified exact and exists precedence plus absent paths; D
   verified an empty desired tree. No exception was observed.
5. **Are `.gitignore` and `.gitattributes` honored as intended?** Yes for the
   tested behaviors. Ignored un-managed output is absent, explicit managed
   ignored content is included, raw CRLF bytes are preserved, and a fresh
   clone's configured synthetic clean filter would have changed the blob ID
   rather than altering the committed raw blob.
6. **Does initial bootstrap always produce one commit?** Every successful
   initial bootstrap in this run produced exactly one parentless commit,
   including D/H's empty trees. A-workflow was rejected before remote push; F/G
   deliberately stopped before bootstrap push. The evidence supports the
   successful cases, not a universal claim for every GitHub policy/token.
7. **Is the created repository correctly reconciled afterward?** Yes for all
   completed paths: effective selectors matched all ten repositories, repository
   settings and E's Actions variables were observed remotely, subsequent plans
   were clean, and ordinary apply did not rerun post-create commands.
8. **Are failure reports and recovery paths operationally usable?** Yes for the
   tested failures. F reported stage, command type, and ordinal without exposing
   sensitive command arguments/output; its retained empty repo was recovered
   through ordinary Octosmith plan/apply. G refused the unsafe generated path
   without a remote push.
9. **Does assisted mode work correctly?** The local PTY selected a strategy and
   the displayed name was the actual repository created. Cancellation created
   nothing; non-TTY, JSON, and dry-run assisted combinations were rejected
   before mutation.
10. **What blocks calling epic #17 operationally verified?** The exercised
    lifecycle is operationally verified for supported, non-workflow paths in
    `grupify`. Re-run A-workflow with an operator-authorized credential carrying
    `Workflows: write` before asserting workflow-file creation. Org rulesets
    also could not be inspected with the current token (`admin:org` absent); no
    ruleset change or org-wide mutation was attempted.

**Current recommendation:** Octosmith's repository creation and bootstrap paths
exercised here are production-capable for private organization repos when the
token has the permissions required by the selected resources. The core create →
bootstrap → reconcile → subsequent plan/apply lifecycle passed. Treat
workflow-containing bootstrap as permission-dependent and not yet verified with
an appropriately scoped token; do not extend this result to uninspected org
rulesets or unsupported resource types.
