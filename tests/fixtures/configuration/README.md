# Configuration fixtures

These fixtures define the external organization and repository facts used to
verify the sample configuration in `examples/configuration/`.

Each repository fixture is resolved against that configuration and compared with
the matching file under `expected/`.

These fixtures describe policy resolution only. They do not model current GitHub
repository state or reconciliation plans.
