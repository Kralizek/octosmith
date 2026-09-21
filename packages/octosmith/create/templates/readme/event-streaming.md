## Event streaming with Hooksmith

The apply workflow creates a local FIFO, starts `hooksmith stream` in the
background using `hooksmith.config.ts`, runs the pinned 0.x
`jsr:@octosmith/cli@0` package with `--events-output` pointed at that FIFO.
Hooksmith runs without `GITHUB_TOKEN`; the organization credential is passed
only to the OctoSmith subprocess. Hooksmith and OctoSmith run as supervised
sibling processes: an early Hooksmith failure terminates OctoSmith, while a
successful Hooksmith completion still waits for and propagates OctoSmith's final
apply status. The direct CLI invocation is intentional here because both
processes must share one shell for supervision. Events therefore reach Hooksmith
as each repository finishes.

The generated Hooksmith configuration handles `resource.applied` events for
`github.repository` subjects and logs each applied repository. Extend that
configuration with additional routes/listeners when you want notifications or
other reactions.
