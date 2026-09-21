# Architecture

OctoSmith separates configuration and planning from command-line hosting and
GitHub transport concerns.

## Packages

### @octosmith/octosmith

The reusable engine:

- configuration loading and validation
- repository selectors and template resolution
- desired/current state models
- plan construction
- reporting
- GitHub discovery and state readers
- mutation sinks and apply helpers
- control-repository scaffolder

### @octosmith/cli

The host:

- command parsing
- validate / plan / apply orchestration
- output format selection
- GitHub runtime construction
- event serialization and output
- process exit behavior

The library must not depend on the CLI.

## Execution flow

```text
configuration
    ↓
load + validate
    ↓
discover repositories
    ↓
resolve one template per repository
    ↓
read current GitHub state
    ↓
build plan
    ↓
report ───────────────┐
    ↓                  │
apply operations       │
    ↓                  │
repository report ◄────┘
```

Plan and apply share discovery, state loading, desired-state resolution, and
planning. Apply differs only after a plan exists.

## Desired state and current state

Configuration is normalized into desired state before planning. GitHub adapters
load current state into a separate model. The planner compares the two and emits
typed operations.

This keeps GitHub REST shapes out of planning logic.

## Collection semantics

Collection management belongs to desired-state interpretation, not GitHub API
transport.

`explicit` preserves undeclared members. `strict` may remove undeclared members
for supported named collections.

## GitHub integration

The GitHub layer is split around interfaces:

- discovery finds repositories in configured scope
- state sources read current repository state
- mutation sinks translate operations into GitHub API calls

This keeps the planner testable without GitHub.

## Reporting

Repository reports are structured data first. Text and JSON are presentation
choices made by the CLI.

Sensitive runtime values and managed file contents must not leak into reports.

## Events

Event emission is a CLI concern layered on repository reports. The core engine
does not depend on Hooksmith.

## Scaffolding

The scaffolder generates a control repository but does not define a separate
runtime architecture. Generated workflows call the same Action/CLI surfaces that
users can invoke directly.
