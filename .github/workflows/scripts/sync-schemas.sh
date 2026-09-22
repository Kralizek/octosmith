#!/usr/bin/env bash
set -euo pipefail

source_dir="schemas"
target_dir="packages/octosmith/configuration/schemas"
mode="${1:-sync}"

schemas=(
  "octosmith.schema.json"
  "template.schema.json"
)

case "$mode" in
  sync)
    mkdir -p "$target_dir"
    for schema in "${schemas[@]}"; do
      cp "$source_dir/$schema" "$target_dir/$schema"
    done
    ;;
  check)
    for schema in "${schemas[@]}"; do
      if ! cmp -s "$source_dir/$schema" "$target_dir/$schema"; then
        echo "Package schema is out of sync: $target_dir/$schema" >&2
        echo "Run: bash .github/workflows/scripts/sync-schemas.sh" >&2
        exit 1
      fi
    done
    ;;
  *)
    echo "Usage: $0 [sync|check]" >&2
    exit 2
    ;;
esac
