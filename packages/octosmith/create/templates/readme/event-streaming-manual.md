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

if [ "$octosmith_status" -ne 0 ]; then
  kill "$hooksmith_pid" 2>/dev/null || true
  wait "$hooksmith_pid" 2>/dev/null || true
  rm -f "$events_pipe"
  exit "$octosmith_status"
fi

wait "$hooksmith_pid"
hooksmith_status=$?
set -e

rm -f "$events_pipe"
exit "$hooksmith_status"
```

Hooksmith receives neither `GITHUB_TOKEN` nor `OCTOSMITH_TOKEN`; the token is
injected only into the OctoSmith subprocess. If apply fails before opening the
FIFO, the shell terminates and reaps Hooksmith before returning the apply
failure. Otherwise it returns the Hooksmith status.
