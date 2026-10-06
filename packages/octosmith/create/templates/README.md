# Octosmith control repository

This repository declares the desired GitHub state for **@@ORGANIZATION@@**.

## Bootstrap

After scaffolding, initialize and push this directory as the organization's
Octosmith control repository. Keep it private if its plans may reveal private
repository configuration.

Create an `OCTOSMITH_TOKEN` Actions secret containing a fine-grained personal
access token with the permissions required by apply. The pull-request validation
workflow does not use this secret. For renewable credentials, replace the static
secret in the generated workflows with a GitHub App token minted at workflow
runtime.

@@WORKFLOW_DOCUMENTATION@@

The generated configuration initially scopes Octosmith to
`@@REPOSITORY_NAME_RAW@@` only and uses `@@COLLECTION_MANAGEMENT_RAW@@`
collection management. Expand the scope and templates deliberately as you adopt
more repositories.

@@EVENT_STREAMING_DOCUMENTATION@@

## Local usage

Validation and permission analysis do not access GitHub and do not require
GitHub credentials. Validation treats environment-backed secrets already present
in the process as available without reading their values:

```sh
deno run -A jsr:@octosmith/cli template validate --path .
deno run -A jsr:@octosmith/cli template permissions --path .
```

Inspect template coverage before planning changes:

```sh
deno run -A jsr:@octosmith/cli resource list --path .
```

Set `GITHUB_TOKEN` before running plan or apply locally, or authenticate with
`gh auth login`:

```sh
deno run -A jsr:@octosmith/cli plan --path .
deno run -A jsr:@octosmith/cli apply --path .
```

Target one repository positionally, or use `--template` to operate on every
repository classified by one template:

```sh
deno run -A jsr:@octosmith/cli plan api-service --path .
deno run -A jsr:@octosmith/cli plan --template repository:libraries --path .
deno run -A jsr:@octosmith/cli apply --template repository:libraries --path .
```

Persist a reviewed plan with `plan --out <file>` and execute those exact stored
operations later with `apply --plan <file>`.
