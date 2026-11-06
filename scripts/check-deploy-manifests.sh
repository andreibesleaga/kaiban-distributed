#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# =============================================================================
# check-deploy-manifests.sh — render and lint the deployment files that no unit
# test covers: every docker compose file and both Helm charts.
#
#   * docker compose config --quiet      for the root and the example stacks
#   * helm lint                          for each chart
#   * helm template                      for each chart, Redis on and off, and a
#     check that every rendered document has an apiVersion and a kind (a
#     whitespace-trim slip in a template once dropped the apiVersion line)
#
# Needs `docker compose` and `helm` (v3) on PATH. CI installs Helm with
# azure/setup-helm (see the deploy-manifests job in .github/workflows/ci.yml).
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v helm >/dev/null || { echo "FAIL: helm is not installed (https://helm.sh/docs/intro/install/)" >&2; exit 1; }
command -v docker >/dev/null || { echo "FAIL: docker is not installed" >&2; exit 1; }

echo "── docker compose config ───────────────────────────────────────────────"
for f in docker-compose.yml examples/*/docker-compose*.yml; do
  docker compose -f "$f" config --quiet
  echo "  ok $f"
done

echo "── helm lint + template ────────────────────────────────────────────────"
for chart in examples/*/infra/helm; do
  helm lint "$chart" --set secrets.OPENAI_API_KEY=sk-test >/dev/null
  echo "  lint ok $chart"
  for redis in true false; do
    out="$(helm template rel "$chart" --set secrets.OPENAI_API_KEY=sk-test \
      --set "redis.enabled=${redis}" --set config.REDIS_URL=redis://external:6379)"
    docs="$(printf '%s\n' "$out" | grep -c '^kind: ')"
    api="$(printf '%s\n' "$out" | grep -c '^apiVersion: ')"
    if [ "$docs" -eq 0 ] || [ "$docs" -ne "$api" ]; then
      echo "FAIL: $chart (redis.enabled=${redis}) renders $docs kinds but $api apiVersions" >&2
      exit 1
    fi
    echo "  template ok $chart redis.enabled=${redis} ($docs objects)"
  done
done
echo "── deploy manifests OK ─────────────────────────────────────────────────"
