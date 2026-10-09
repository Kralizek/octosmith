# @octosmith/octosmith

GitHub adapter for Octosmith, using REST and atomic GraphQL ref updates.

Use `applyPlan` to execute a repository plan. Before the first operation, the
GitHub sink resolves and snapshots all required repository and environment
secret values. If preparation fails, `applyPlan` rejects without sending any
mutation requests, including strict-mode deletions. Direct calls to the
low-level sink's `apply` method do not provide this plan-wide preflight.

Preparation does not make GitHub writes transactional: later API failures may
leave earlier operations applied. Execution stops at the first failed operation
by default and reports remaining operations as skipped.

PR-mode delivery requires `Plan.managedFiles`, containing the complete desired
file list, target branch, and target commit SHA. `applyPlan` passes this
snapshot to the sink and invokes its finish hook even when there are no
operations. Missing or stale snapshots fail safely; do not call the low-level
file `apply` method with only a partial operation batch in PR mode.

`ApplyPlanResult.pullRequests` contains successful `PullRequestResult` entries.
`ApplyPlanOptions.onPullRequest` observes those same outcomes immediately,
before later operations can fail. Finish-time failures appear in
`ApplyPlanResult.error`. The library does not serialize events or depend on
Hooksmith.

Reconciliation branches are rebuilt from the target, protected by atomic
expected-SHA updates and a temporary exclusive lock ref. PR closure retains the
empty-delta branch for reuse. See the
[file-delivery lifecycle](../../../docs/configuration.md#reconciliation-lifecycle)
for ownership and recovery rules.
