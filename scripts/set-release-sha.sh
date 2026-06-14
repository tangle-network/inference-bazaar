#!/usr/bin/env bash
# Pin the published operator-binary sha256 (and optionally the tag) into the
# blueprint definitions so `cargo tangle blueprint deploy` verifies the artifact
# it fetches. Run after the `release` workflow publishes the binary.
#
#   scripts/set-release-sha.sh <sha256> [vTAG]
set -euo pipefail
cd "$(dirname "$0")/.."

SHA="${1:?usage: set-release-sha.sh <sha256> [vTAG]}"
TAG="${2:-}"
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "sha256 must be 64 lowercase hex chars"; exit 1; }

for f in deploy/blueprint-definition.toml deploy/blueprint-definition.sepolia.toml; do
  [ -f "$f" ] || continue
  sed -i -E "s/sha256 = \"[0-9a-fA-F]*\"/sha256 = \"$SHA\"/g" "$f"
  [ -n "$TAG" ] && sed -i -E "s/tag = \"v[^\"]*\"/tag = \"$TAG\"/g" "$f"
  echo "pinned $f -> sha256=$SHA ${TAG:+tag=$TAG}"
done
echo "Commit the manifests, then: deploy/base-sepolia.sh"
