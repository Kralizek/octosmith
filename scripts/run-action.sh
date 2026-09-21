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

deno run --config "$GITHUB_ACTION_PATH/deno.json" -A   "$GITHUB_ACTION_PATH/packages/cli/mod.ts"   "${args[@]}"
