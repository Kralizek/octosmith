# OctoSmith control repository

This repository declares the desired GitHub state for **@@ORGANIZATION@@**.

## Bootstrap

After scaffolding, initialize and push this directory as the organization's
OctoSmith control repository. Keep it private if its plans may reveal private
repository configuration.

Create an `OCTOSMITH_TOKEN` Actions secret containing a fine-grained personal
access token with the permissions required by apply. The pull-request validation
workflow does not use this secret. For renewable credentials, replace the static
secret in the generated workflows with a GitHub App token minted at workflow
runtime.

@@WORKFLOW_DOCUMENTATION@@

The generated configuration initially scopes OctoSmith to
`@@REPOSITORY_NAME_RAW@@` only and uses `@@COLLECTION_MANAGEMENT_RAW@@`
collection management. Expand the scope and templates deliberately as you adopt
more repositories.

@@EVENT_STREAMING_DOCUMENTATION@@

## Local usage

Validation is offline and does not require `GITHUB_TOKEN`:

```sh
deno run -A jsr:@octosmith/cli validate --path .
```

Set `GITHUB_TOKEN` before running plan or apply locally:

```sh
deno run -A jsr:@octosmith/cli plan --path .
deno run -A jsr:@octosmith/cli apply --path .
```
