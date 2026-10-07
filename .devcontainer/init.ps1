$token = gh auth token

if (-not $token) {
    throw "Could not obtain GitHub token from 'gh auth token'"
}

@"
GITHUB_TOKEN=$token
GH_TOKEN=$token
"@ | Set-Content -NoNewline .devcontainer/.env.local