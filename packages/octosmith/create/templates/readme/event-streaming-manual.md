## Event streaming with Hooksmith

`hooksmith.config.ts` was generated because scaffolding used
`--event-streaming`, but no workflows were generated. To stream manually, create
a FIFO, run `hooksmith stream` against the generated configuration in the
background, run OctoSmith with `--events-output` pointing at the FIFO, and wait
for Hooksmith to finish.
