#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# =============================================================================
# check-tag-version.sh — release guard: the Git tag a workflow runs on must be
# `v<package.json version>`. Stops a tag pushed before the version bump (or a
# manual run from a branch) from publishing, signing or releasing the wrong build.
#
# Usage (from a workflow job, first step after checkout):
#   bash scripts/check-tag-version.sh
# Reads GITHUB_REF_TYPE and GITHUB_REF_NAME (set by GitHub Actions). Optional
# argument: the directory that holds package.json (default: the repo root).
# Exit 0 = tag matches; exit 1 = not a tag, or the tag and the version differ.
# =============================================================================
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if [ "${GITHUB_REF_TYPE:-}" != "tag" ]; then
  echo "FAIL: this workflow publishes releases, so it must run on a version tag (ref: ${GITHUB_REF_NAME:-unknown}). Use: gh workflow run <file> --ref vX.Y.Z" >&2
  exit 1
fi

VERSION="$(node -p "require(process.argv[1] + '/package.json').version" "$DIR")"
if [ "${GITHUB_REF_NAME:-}" != "v${VERSION}" ]; then
  echo "FAIL: tag ${GITHUB_REF_NAME:-<none>} does not match package.json version ${VERSION} (expected v${VERSION}). Bump the version first (docs/RELEASE.md step 1)." >&2
  exit 1
fi
echo "tag ${GITHUB_REF_NAME} matches package.json ${VERSION}"
