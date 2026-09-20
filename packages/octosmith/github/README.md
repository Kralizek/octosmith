# @octosmith/octosmith

GitHub REST adapter for OctoSmith.

Use `applyPlan` to execute a repository plan. Before the first operation, the
GitHub sink resolves and snapshots all required repository and environment
secret values. If preparation fails, `applyPlan` rejects without sending any
mutation requests, including strict-mode deletions. Direct calls to the
low-level sink's `apply` method do not provide this plan-wide preflight.

Preparation does not make GitHub writes transactional: later API failures may
leave earlier operations applied. Execution stops at the first failed operation
by default and reports remaining operations as skipped.
