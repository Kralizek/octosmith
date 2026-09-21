## Event streaming with Hooksmith

`hooksmith.config.ts` was generated because scaffolding used
`--event-streaming`, but no workflows were generated. Keep the organization
credential scoped to OctoSmith when streaming manually:

```sh
read -rsp "OctoSmith token: " OCTOSMITH_TOKEN
echo

events_pipe="/tmp/octosmith-events"
rm -f "$events_pipe"
mkfifo "$events_pipe"

env -u GITHUB_TOKEN -u OCTOSMITH_TOKEN \
  deno run -A jsr:@hooksmith/cli stream \
    --config ./hooksmith.config.ts \
    < "$events_pipe" &
hooksmith_pid=$!

GITHUB_TOKEN="$OCTOSMITH_TOKEN" \
  deno run -A jsr:@octosmith/cli@0 apply \
    --path . \
    --events-output "$events_pipe"

wait "$hooksmith_pid"
rm -f "$events_pipe"
```

Hooksmith receives neither `GITHUB_TOKEN` nor `OCTOSMITH_TOKEN`; the token is
injected only into the OctoSmith subprocess.
