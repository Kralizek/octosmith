# Managed-file reconciliation investigation

## Confirmed cause

The investigated failure was a protected-target ruleset rejection, not evidence
of concurrent writers or unsupported reference creation. Identifying operational
details are omitted from this public report.

Read-only GitHub rule-suite records identify the rejected operation:

- The automation App attempted a same-SHA update to the protected target.
- The failed evaluation timestamp matched the failed reconciliation run.
- The active target-branch ruleset rejected the operation.
- Failed rule: `pull_request`, with the detail "Changes must be made through a
  pull request."
- An earlier attempt failed the same rule. Non-fast-forward and deletion rules
  passed in both evaluations.

These records can be inspected without modifying the repository:

```sh
gh api "repos/$OWNER/$REPOSITORY/rulesets/rule-suites/$RULE_SUITE_ID"
```

The old transaction submitted an update to the target with identical before and
after SHAs, intending only to verify it. GitHub still evaluated that entry as a
protected-branch update. Because the mutation is atomic, the rejected target
entry also prevented creation of both reserved references. Repeating the same
plan could not resolve this policy rejection.

The workflow's App client ID matches the installed automation App, which has
Contents, Pull Requests, and Workflows write permissions. The ruleset bypass
list includes repository administrators, not that App. No permission expansion
or protection bypass is needed for this fix. Successful secret updates alone
would not have established file permissions.

## GitHub API behavior

[GitHub documents `updateRefs`](https://docs.github.com/en/graphql/reference/git#updaterefs)
as supporting atomic creation, update, and deletion of multiple references:

- A zero `beforeOid` asserts absence and allows creation.
- A zero `afterOid` requests deletion.
- Any rejected update prevents all updates in the mutation.

A disposable private repository confirmed that the original three-entry
transaction can create both absent reserved refs on an unprotected target.
Conditional deletion and subsequent recreation also succeeded, including with
Octosmith's `X-GitHub-Api-Version: 2026-03-10` header. Repeating creation with
the refs occupied returned an opaque GraphQL error containing a GitHub support
correlation ID, not a reliable structured concurrency code.

The previous managed-file PR was merged and its reserved branch is absent. This
is an ordinary bootstrap case, not a reason to adopt or manually recreate a
branch. It does not explain the protected-target rejection.

## Implementation and safety

The target reference is no longer included in `updateRefs`. Instead:

1. Validate the immutable planned target before preparing file changes and again
   immediately before the reserved-ref transaction.
2. Atomically compare-and-swap the reserved reconciliation branch from its
   observed owned head (or assert absence) and create the absent lock. A failure
   changes neither ref. There is no unconditional REST fallback.
3. With the lock held, verify the branch, lock, and planned target before PR
   work, and revalidate around PR/label mutations and after lock release.
4. Release only the lock whose OID still matches this transaction, including
   after a failed PR operation. Never delete a replacement or pre-existing lock.

Branch ownership checks, complete desired-state validation, and PR ownership
checks remain in place. The target is never written or force-updated. Force is
used only for a known owned reconciliation branch with its expected old OID.

Target validation is deliberately separate from the atomic reserved-ref CAS;
GitHub's protected no-op update cannot serve as a read-only transactional
assertion. If the target changes across acquisition, the candidate branch can
already exist, but reconciliation fails before PR work and releases its lock. It
leaves that owned candidate in place for a fresh plan rather than attempting a
destructive rollback. Target changes around later API calls are detected by the
existing boundary checks; PR metadata APIs do not provide an atomic transaction
with target refs. An externally changed target that returns to the same SHA
between reads is not detectable by these snapshot checks.

GraphQL rejections now retain GitHub messages, error type/extension code when
supplied, repository, and stage. Follow-up reads may report an observed ref
conflict, but do not reinterpret every API rejection as a race or perform any
fallback write. Cleanup errors retain both the original failure and cleanup
diagnostics. HTTP errors include status and the API message, not raw response
bodies, request payloads, credentials, or headers.

## Validation

- Managed-file PR tests: 79 passed. Coverage includes protected-target no-op
  rejection, first creation, recreation after a merged PR and deleted branch,
  existing owned branches, occupied/replaced locks, stale targets, overlapping
  writers, GraphQL/HTTP diagnostics, and successful/failed-operation cleanup.
- Full type-checked suite (`deno task test`): 788 passed, zero failures.
- Changed TypeScript formatting, repository-wide lint, export-doc checks, and
  `git diff --check` passed.
- `deno task check` stops on pre-existing formatting changes in
  `docs/architecture.md`, `docs/configuration.md`, and `packages/cli/README.md`.
  Those user edits were not changed. The remaining gates were run separately.
- No production repository writes, configuration changes, or PR actions were
  performed. The protected-target cause was established from production rule
  history, not by experimenting with production protections or App credentials.
- All experimental refs in the disposable private repository were conditionally
  deleted; only its initial default branch remains. Repository deletion returned
  HTTP 403 with the available credential, so the empty-of-experiments private
  repository needs owner cleanup through GitHub Settings. No PRs were created
  there.

## Safe retry

Do not retry with unchanged Octosmith 0.9.0. Review this fix and use a release
containing it, or run the CLI from this reviewed checkout. No rule relaxation,
App bypass, manual branch creation/deletion, or secret rewrite is required.

In an authorized shell, authenticate as the same App through the normal token
minting mechanism. Do not print the token. Keep the control repository unchanged
and substitute its existing checkout path below:

```sh
CONTROL_REPO=/path/to/control-repository
REPOSITORY=example-repository
PLAN=/tmp/managed-files.octosmith-plan.json
deno run -A /workspaces/Octosmith/packages/cli/mod.ts plan "$REPOSITORY" \
  --path "$CONTROL_REPO/github" --include-secrets=false --out "$PLAN"
```

Review the fresh plan before applying it. It must target only the intended
repository and contain only the expected managed-file change. Stop if repository
configuration or other unexpected operations appear. Confirm that no other
reconciliation is running and that `octosmith/reconcile-lock` is absent. Do not
manually remove a lock if one appears; establish its owner first.

After explicit authorization for the reviewed file-only apply:

```sh
deno run -A /workspaces/Octosmith/packages/cli/mod.ts apply \
  --path "$CONTROL_REPO/github" --plan "$PLAN"
```

Saved plans use their recorded secret policy, so excluding secrets must happen
when creating the plan, not merely on the saved-plan apply command. A stale
target requires a fresh plan, not a force retry. After success, verify one open
Octosmith PR targeting the planned branch, the intended file diff, an unchanged
target SHA, and no lock ref. Leave the PR open for review; do not merge or close
it as part of this retry. These retry commands were not executed during the
investigation.
