## Event streaming with Hooksmith

The apply workflow creates a local FIFO and runs Hooksmith in an isolated
official Deno container while OctoSmith runs on the GitHub runner. Only a copied
`hooksmith.config.ts` is mounted into the container, read-only; the repository,
runner process space, and organization credential are not exposed to Hooksmith.

OctoSmith runs the pinned 0.x `jsr:@octosmith/cli@0` package with
`--events-output` pointed at the FIFO. The FIFO is connected to the Hooksmith
container over stdin, so events reach Hooksmith as each repository finishes.

Hooksmith and OctoSmith remain supervised sibling processes: an early Hooksmith
failure terminates OctoSmith, while an OctoSmith failure stops the Hooksmith
container. Successful completion preserves each process's final status.

The generated Hooksmith configuration handles `resource.applied` events for
`github.repository` subjects and logs each applied repository. Extend that
configuration with additional routes/listeners when you want notifications or
other reactions.
