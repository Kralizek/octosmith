#!/usr/bin/env bash
set -euo pipefail

source_dir="schemas"
target_dir="packages/octosmith/configuration/schemas"

rm -rf "$target_dir"
mkdir -p "$target_dir"
cp -R "$source_dir"/. "$target_dir"/

cp "$source_dir/plan.schema.json" "packages/octosmith/plan/plan.schema.json"
