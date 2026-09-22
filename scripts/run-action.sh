#!/usr/bin/env bash
set -euo pipefail

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

mode="$(trim "${OCTOSMITH_MODE:-}")"
path="$(trim "${OCTOSMITH_PATH:-.}")"
repository="$(trim "${OCTOSMITH_REPOSITORY:-}")"
format="$(trim "${OCTOSMITH_FORMAT:-text}")"
verbose="$(trim "${OCTOSMITH_VERBOSE:-false}")"
events_output="$(trim "${OCTOSMITH_EVENTS_OUTPUT:-}")"

deno_args=(--quiet --minimum-dependency-age 0)
if [[ -n "${OCTOSMITH_CLI_ENTRYPOINT:-}" ]]; then
  cli="$OCTOSMITH_CLI_ENTRYPOINT"
else
  version="$(deno eval --allow-read="$GITHUB_ACTION_PATH/packages/cli/deno.json" 'const manifest = JSON.parse(await Deno.readTextFile(Deno.args[0])); console.log(manifest.version);' "$GITHUB_ACTION_PATH/packages/cli/deno.json")"
  cli="jsr:@octosmith/cli@${version}"
fi

if [[ -z "$format" ]]; then
  format="text"
fi

case "$mode" in
  validate|plan|apply) ;;
  *)
    echo "::error::mode must be 'validate', 'plan', or 'apply'." >&2
    exit 1
    ;;
esac

case "$format" in
  text|json) ;;
  *)
    echo "::error::format must be either 'text' or 'json'." >&2
    exit 1
    ;;
esac

normalized_verbose="$(printf '%s' "$verbose" | tr '[:upper:]' '[:lower:]')"

case "$normalized_verbose" in
  true)
    verbose=true
    ;;
  false)
    verbose=false
    ;;
  *)
    echo "::error::verbose must be either 'true' or 'false'." >&2
    exit 1
    ;;
esac

if [[ -z "$path" ]]; then
  path="."
fi

if [[ "$mode" == "validate" ]]; then
  if [[ -n "$repository" ]]; then
    echo "::error::repository is not supported for validate." >&2
    exit 1
  fi
  if [[ "$verbose" == "true" ]]; then
    echo "::error::verbose is not supported for validate." >&2
    exit 1
  fi
  if [[ -n "$events_output" ]]; then
    echo "::error::events-output is not supported for validate." >&2
    exit 1
  fi
fi

args=("$mode")
if [[ -n "$repository" ]]; then
  args+=("$repository")
fi
args+=(--path "$path" --format "$format")

if [[ "$verbose" == "true" ]]; then
  args+=(--verbose)
fi

if [[ -n "$events_output" ]]; then
  args+=(--events-output "$events_output")
fi

deno run "${deno_args[@]}" -A "$cli" "${args[@]}"
