## Event streaming with Hooksmith

`hooksmith.config.ts` was generated because scaffolding used
`--event-streaming`, but no workflows were generated. For the same isolation
model as the generated workflow, run Hooksmith in a container and keep the
organization credential only on the host OctoSmith process:

```sh
read -rsp "OctoSmith token: " OCTOSMITH_TOKEN
echo

stream_dir="$(mktemp -d)"
events_pipe="$stream_dir/events"
hooksmith_container="octosmith-hooksmith-manual"

cp ./hooksmith.config.ts "$stream_dir/hooksmith.config.ts"
mkfifo "$events_pipe"

cleanup() {
  docker rm -f "$hooksmith_container" >/dev/null 2>&1 || true
  rm -rf "$stream_dir"
}
trap cleanup EXIT

docker run --rm --name "$hooksmith_container" -i \
  --mount type=bind,src="$stream_dir",dst=/hooksmith,readonly \
  --workdir /hooksmith \
  denoland/deno:2.x \
  run -A jsr:@hooksmith/cli@0 stream \
    --config ./hooksmith.config.ts \
    < "$events_pipe" &
hooksmith_pid=$!

GITHUB_TOKEN="$OCTOSMITH_TOKEN" \
  deno run -A jsr:@octosmith/cli@0 apply \
    --path . \
    --events-output "$events_pipe" &
octosmith_pid=$!

set +e
wait -n -p completed_pid "$hooksmith_pid" "$octosmith_pid"
first_status=$?
set -e

if [ "$completed_pid" = "$hooksmith_pid" ]; then
  if [ "$first_status" -ne 0 ]; then
    kill "$octosmith_pid" 2>/dev/null || true
    wait "$octosmith_pid" 2>/dev/null || true
    exit "$first_status"
  fi

  set +e
  wait "$octosmith_pid"
  octosmith_status=$?
  set -e
  exit "$octosmith_status"
fi

if [ "$first_status" -ne 0 ]; then
  docker rm -f "$hooksmith_container" >/dev/null 2>&1 || true
  kill "$hooksmith_pid" 2>/dev/null || true
  wait "$hooksmith_pid" 2>/dev/null || true
  exit "$first_status"
fi

set +e
wait "$hooksmith_pid"
hooksmith_status=$?
set -e
exit "$hooksmith_status"
```

The container receives only the copied Hooksmith configuration and event stdin;
it does not receive `GITHUB_TOKEN` or `OCTOSMITH_TOKEN`. Both direct CLI
invocations are pinned to their respective 0.x release lines.
