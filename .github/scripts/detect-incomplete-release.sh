#!/usr/bin/env bash
set -euo pipefail

latest_tag="$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
echo "latest-tag=$latest_tag" >> "$GITHUB_OUTPUT"
echo "resume=false" >> "$GITHUB_OUTPUT"

if [[ -z "$latest_tag" ]]; then
  exit 0
fi

tag_version="${latest_tag#v}"
release_commit="$(git rev-parse "$latest_tag^{commit}")"

while IFS= read -r member; do
  manifest_version="$(git show "$latest_tag:$member/deno.json" | jq -r .version 2>/dev/null || true)"
  if [[ "$manifest_version" != "$tag_version" ]]; then
    exit 0
  fi
done < <(jq -r '.workspace[]' deno.json)

all_published=true
while IFS= read -r member; do
  package_name="$(git show "$latest_tag:$member/deno.json" | jq -r .name)"
  package_meta="$(curl -fsSL -H 'Accept: application/json' "https://jsr.io/${package_name}/meta.json" || true)"

  if [[ -z "$package_meta" ]] || ! jq -e --arg version "$tag_version" '.versions[$version] != null' <<< "$package_meta" >/dev/null; then
    all_published=false
  fi
done < <(jq -r '.workspace[]' deno.json)

IFS='.' read -r major minor patch <<< "$tag_version"
major_tag="v$major"
minor_tag="v$major.$minor"

major_commit="$(git rev-parse -q --verify "$major_tag^{commit}" 2>/dev/null || true)"
minor_commit="$(git rev-parse -q --verify "$minor_tag^{commit}" 2>/dev/null || true)"

release_published=false
if release_json="$(gh release view "$latest_tag" --json isDraft 2>/dev/null)"; then
  if [[ "$(jq -r .isDraft <<< "$release_json")" == "false" ]]; then
    release_published=true
  fi
fi

if [[ "$all_published" == "true" &&
      "$major_commit" == "$release_commit" &&
      "$minor_commit" == "$release_commit" &&
      "$release_published" == "true" ]]; then
  exit 0
fi

previous_tag="$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | grep -Fxv "$latest_tag" | sort -V | tail -n 1 || true)"
echo "resume=true" >> "$GITHUB_OUTPUT"
echo "version=$tag_version" >> "$GITHUB_OUTPUT"
echo "tag=$latest_tag" >> "$GITHUB_OUTPUT"
echo "previous-tag=$previous_tag" >> "$GITHUB_OUTPUT"
echo "Resuming incomplete release $latest_tag until packages, moving tags, and GitHub release are all complete."
