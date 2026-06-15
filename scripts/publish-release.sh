#!/usr/bin/env bash
# Pushes CasinoSpy to GitHub and publishes a Release with the notarized DMG.
#
# Usage:
#   GH_TOKEN=<your PAT with 'repo' scope> bash scripts/publish-release.sh
#
# A classic Personal Access Token needs the `repo` scope; a fine-grained token
# needs Contents: read/write on WynterJones/CasinoSpy. Create one at:
#   https://github.com/settings/tokens
set -euo pipefail

REPO="WynterJones/CasinoSpy"
TAG="v0.2.0"
DMG="src-tauri/target/release/bundle/dmg/CasinoSpy_0.2.0_aarch64.dmg"
cd "$(dirname "$0")/.."

# Resolve a token: env -> gh CLI -> keychain.
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then TOKEN="$(gh auth token 2>/dev/null || true)"; fi
if [ -z "$TOKEN" ]; then TOKEN="$(security find-internet-password -s github.com -a WynterJones -w 2>/dev/null || true)"; fi
if [ -z "$TOKEN" ]; then echo "No token found. Re-run as: GH_TOKEN=<pat> bash scripts/publish-release.sh"; exit 1; fi

echo "==> Pushing code"
git push "https://x-access-token:${TOKEN}@github.com/${REPO}.git" main:main

echo "==> Creating release $TAG"
api() { curl -fsS -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }
REL=$(api "https://api.github.com/repos/${REPO}/releases" \
  -d "{\"tag_name\":\"${TAG}\",\"name\":\"CasinoSpy ${TAG}\",\"body\":\"Signed + notarized macOS build (Apple Silicon). Blackjack + IGT Game King video poker perfect-strategy overlay.\",\"draft\":false,\"prerelease\":false}" \
  2>/dev/null || api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")
REL_ID=$(printf '%s' "$REL" | sed -n 's/.*"id": *\([0-9]*\).*/\1/p' | head -1)
echo "release id: ${REL_ID}"

echo "==> Uploading DMG"
curl -fsS -H "Authorization: token $TOKEN" -H "Content-Type: application/x-apple-diskimage" \
  --data-binary @"$DMG" \
  "https://uploads.github.com/repos/${REPO}/releases/${REL_ID}/assets?name=CasinoSpy_0.2.0_aarch64.dmg" \
  >/dev/null && echo "Uploaded $DMG"

echo "Done -> https://github.com/${REPO}/releases/tag/${TAG}"
