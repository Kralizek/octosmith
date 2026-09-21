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

set +e
GITHUB_TOKEN="$OCTOSMITH_TOKEN" \
  deno run -A jsr:@octosmith/cli@0 apply \
    --path . \
    --events-output "$events_pipe"
octosmith_status=$?

wait "$hooksmith_pid"
hooksmith_status=$?
set -e

rm -f "$events_pipe"

if [ "$octosmith_status" -ne 0 ]; then
  exit "$octosmith_status"
fi

exit "$hooksmith_status"
```

Hooksmith receives neither `GITHUB_TOKEN` nor `OCTOSMITH_TOKEN`; the token is
injected only into the OctoSmith subprocess. The shell preserves the apply
failure status, or the Hooksmith failure when apply succeeds.
