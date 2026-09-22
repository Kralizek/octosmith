#!/usr/bin/env bash
set -euo pipefail

source_dir="schemas"
target_dir="packages/octosmith/configuration/schemas"

rm -rf "$target_dir"
mkdir -p "$target_dir"
cp "$source_dir/octosmith.schema.json" "$target_dir/octosmith.schema.json"
cp "$source_dir/template.schema.json" "$target_dir/template.schema.json"
