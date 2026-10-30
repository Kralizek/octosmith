# Octosmith Local E2E Acceptance Report

**Run date:** 2026-10-30\
**Acceptance target:** GitHub repository creation from epic #17 and issues
#108–#113\
**Overall status:** **Live GitHub acceptance blocked; local checks and offline
preview passed**

## Environment

| Item                           | Observed                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tested commit                  | `1bac1cbe4d5779519dee0ae0cf216b1d4f7af880` (`Add assisted CLI resolution of creation ambiguities (#123)`)                                                                                               |
| Branch and remote              | `master`; `git ls-remote origin refs/heads/master` returned the same SHA                                                                                                                                |
| Operating system               | Linux x86_64, WSL2 kernel `6.18.54.1-microsoft-standard-WSL2`                                                                                                                                           |
| Deno                           | `2.9.7` stable                                                                                                                                                                                          |
| Git                            | `2.55.0`                                                                                                                                                                                                |
| GitHub CLI                     | `2.102.0`                                                                                                                                                                                               |
| GitHub identity                | Authenticated CLI; `gh api user --jq .login` returned `Kralizek`                                                                                                                                        |
| Test organization/account      | **Not explicitly designated.** The fixture's `acme` organization is synthetic and was not treated as an authorized test target.                                                                         |
| Disposable repository prefix   | **Not provided or configured.**                                                                                                                                                                         |
| Authentication and permissions | `GH_TOKEN` is configured and the current-user API call succeeded. No organization or repository-creation permission was verified for a test target. The token value was not read, printed, or recorded. |

No separate executable/package build task is defined in `deno.json`. The CLI was
run directly from `packages/cli/mod.ts`; no globally installed Octosmith was
used.

## Local checks and preview

The first `deno task check` stopped at `deno fmt --check` because this requested
report was not yet formatted. After formatting the report, the complete
`deno task check` passed.

| Check                       | Result                                                       |
| --------------------------- | ------------------------------------------------------------ |
| `deno task check`           | Passed end-to-end                                            |
| `deno task sync:schemas`    | Passed as part of the task                                   |
| `deno fmt --check`          | Passed after report formatting                               |
| `deno lint`                 | Passed; 107 files checked                                    |
| `deno task check:docs`      | Passed                                                       |
| `deno test -A`              | Passed; 1041 passed, 0 failed                                |
| OpenCLI contract validation | Passed; targeted test 10 passed                              |
| CLI source entry point      | `deno run -A packages/cli/mod.ts --help` exited successfully |

Local fixture operations used the source CLI and
`tests/fixtures/creation-preview`, an existing synthetic fixture:

The fixture's root scope is constrained by `team-*-svcs` names, private or
internal visibility, the `platform` team, and the `tier: backend` property. Its
configured `acme` owner is synthetic. No organization-wide `apply` or live
mutation command was run.

```text
deno run -A packages/cli/mod.ts template validate \
  --path tests/fixtures/creation-preview
  passed: configuration valid; unresolved runtime-value warnings were reported

deno run -A packages/cli/mod.ts resource create services \
  --name team-e2e-preview-svcs --visibility private --dry-run \
  --path tests/fixtures/creation-preview
  passed: resolved explicit identity, private visibility, default branch trunk,
  two present managed files, one absent declaration, and two post-create
  command names; no creation or bootstrap work was executed

deno run -A packages/cli/mod.ts resource create services \
  --name team-e2e-preview-svcs --visibility private --dry-run \
  --format json --path tests/fixtures/creation-preview
  passed: structured preview resolved the same identity and intent; command
  arguments and file contents were not included in the output
```

The preview reports five unresolved runtime-backed variables/secrets as warnings
and lists GitHub operations deferred until execution. This is expected for the
synthetic fixture and does not establish that a real create would succeed. Both
previews explicitly reported that no repository was created.

An initial exploratory preview used `octosmith-e2e-offline-preview`, which does
not match the fixture's `team-*-svcs` scope. The CLI correctly exited
unsuccessfully with `metadata_outside_intersection`; the selector-compliant
preview above then passed. No remote mutation was attempted.

No isolated live-test workspace, generated fixture set, or remote execution log
was created because there was no explicitly authorized target. No GitHub
repository was created by this run.

## Scenario results

| Scenario ID                          | Expected behavior                                                                                                                        | Actual behavior                                                                                                                                                            | Status                             | GitHub repository URL | Evidence                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------- | ----------------------------------------------------- |
| A — Declarative files                | Private repository, exact/exists bytes, one initial commit, no bootstrap PR, clean subsequent file reconciliation                        | No live creation or remote tree/blob inspection. Existing local tests passed.                                                                                              | **BLOCKED**                        | None                  | Full local suite only                                 |
| B — Generated files                  | Ordered commands run in repository root; generated bytes/modes retained, ignored output excluded                                         | No generator was run against a live creation. Preview displayed command names but did not execute them.                                                                    | **BLOCKED**                        | None                  | Offline text/JSON preview; no generated-file evidence |
| C — Generated/declarative collisions | Declarative exact/exists/absent precedence, ignore/attributes behavior, and final Git blobs/modes independently verified                 | No live bootstrap or Git tree/blob inspection.                                                                                                                             | **BLOCKED**                        | None                  | Automated tests only; no remote evidence              |
| D — Empty initial repository         | One empty root commit, default branch, no extra commit/push, later reconciliation succeeds                                               | Not attempted against GitHub.                                                                                                                                              | **BLOCKED**                        | None                  | Automated tests only                                  |
| E — Fragments/composition            | Effective composed template verified, including overrides and command replacement/clearing                                               | Existing fixture validation and previews succeeded; it composes a fragment and template, but no repository was created.                                                    | **PARTIAL (LOCAL ONLY)**           | None                  | `template validate`; text and JSON preview            |
| Strict creation resolution           | Explicit/automatic identity; ambiguity, invalid-name, scope, and collision safeguards; no prompts                                        | Explicit selector-compliant name/private visibility resolved in offline preview. Automatic naming, remote collisions, and mutation safeguards not independently exercised. | **PARTIAL (LOCAL ONLY)**           | None                  | Source CLI preview; full automated suite              |
| Assisted creation                    | Interactive choices, correction/cancellation, TTY restrictions, clean stdout, no mutation on cancel                                      | No real PTY or live assisted operation. Automated tests passed in the full suite.                                                                                          | **PARTIAL (AUTOMATED TESTS ONLY)** | None                  | Full automated suite                                  |
| Preview consistency                  | Text/JSON preview compared with an equivalent actual create                                                                              | Text and JSON previews were consistent offline; no matching actual creation was possible.                                                                                  | **PARTIAL (PREVIEW ONLY)**         | None                  | Source CLI text/JSON output                           |
| Metadata/reconciliation              | GitHub metadata/resources converge, scope classification is unique, plan clean, no duplicate bootstrap, later apply honors delivery mode | Not attempted against GitHub.                                                                                                                                              | **BLOCKED**                        | None                  | No remote plan/apply evidence                         |
| Failed command and recovery          | Retained repository remains empty after bootstrap failure; safe plan/apply recovery path verified                                        | Not attempted against GitHub.                                                                                                                                              | **BLOCKED**                        | None                  | No disposable failure repository                      |
| Unsafe generated file                | Unsafe path/symlink rejected without bootstrap push                                                                                      | Not attempted against GitHub.                                                                                                                                              | **BLOCKED**                        | None                  | No remote failure evidence                            |
| Existing-name collision              | Existing disposable repository is not adopted or altered                                                                                 | Not attempted; no designated disposable repository or prefix.                                                                                                              | **BLOCKED**                        | None                  | No collision test performed                           |

## Findings

### Confirmed defects

None found by the local checks. The absence of a reproduced local defect is not
evidence that the remote creation lifecycle meets the acceptance criteria.

### Environment limitations

- **Live acceptance blocked:** no operator-designated test organization or
  account and no disposable repository prefix were available. The authenticated
  `Kralizek` identity was not assumed safe for testing.
- **Creation permissions unverified:** authentication and a current-user API
  request succeeded, but no target organization was available against which to
  check creation permissions or settings constraints.
- **Remote evidence unavailable:** no create, apply, clone, GitHub API tree
  inspection, or repository cleanup decision was made.

To resume safely, designate an explicitly disposable organization/account and a
prefix such as `octosmith-e2e-YYYYMMDD-`. Confirm permissions and organization
constraints, construct each intended name under that prefix, and verify every
name is unused before creation. Do not provide credentials in chat.

### Unverified concerns

Remote generated/declarative precedence, raw bytes and line endings,
`.gitignore` and `.gitattributes` behavior, executable modes, empty-tree commit
semantics, initial push count, pull-request behavior, metadata reconciliation,
failure redaction, and recovery remain unverified. Local tests and preview do
not substitute for independent GitHub verification.

## Resource inventory

| Repository   | Final state                 | Manual cleanup |
| ------------ | --------------------------- | -------------- |
| None created | No remote resources changed | None           |

## Final assessment

1. **Can Octosmith create a repository end-to-end?** Not established by this
   run. Offline creation resolution worked, but no remote repository was
   created.
2. **Does managed-file materialization work correctly?** Not independently
   established against GitHub.
3. **Do generated files coexist correctly with declarative files?** Not
   established by live acceptance; collision precedence remains unverified.
4. **Are `exact`, `exists`, and `absent` handled correctly?** The local preview
   resolved declarations for these states, but remote bootstrap results were not
   verified.
5. **Are `.gitignore` and `.gitattributes` honored as intended?** Not
   independently verified.
6. **Does initial bootstrap always produce one commit?** Not established
   remotely, including the empty-content case.
7. **Is the created repository correctly reconciled afterward?** Not
   established; no repository was created for a follow-on plan/apply.
8. **Are failure reports and recovery paths operationally usable?** Not
   established against a retained live failure repository.
9. **Does assisted mode work correctly?** Automated tests passed, but actual
   interactive terminal behavior and live no-mutation safeguards were not
   independently tested.
10. **What blocks calling epic #17 operationally verified?** An explicitly
    authorized test owner and disposable prefix, plus successful live scenarios
    and independent remote-state verification.

**Recommendation:** Do not call repository creation operationally verified or
production-ready based on this run. Local checks and offline previews passed,
but the priority acceptance criteria—real creation, generated/declarative
precedence, single-commit semantics, and safe failure recovery—remain blocked
pending a designated disposable GitHub target.
