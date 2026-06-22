#!/usr/bin/env bash
# =============================================================================
# smoke-consumer.sh — pack the Apache-2.0 library tarball and verify a fresh
# external consumer can import the public surface from BOTH entry points
# (`kaiban-distributed` and `kaiban-distributed/shared`). Catches exports/files
# regressions that the in-repo tests can't (they import from src/, not the
# published package). Run before tagging a release.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "── Build + pack the Apache library tarball ─────────────────────────────"
npm run build >/tmp/smoke-build.log 2>&1 || { echo "FAIL: build"; tail -15 /tmp/smoke-build.log; exit 1; }
bash scripts/pack-staging.sh >/tmp/smoke-pack.log 2>&1 || { echo "FAIL: pack"; tail -15 /tmp/smoke-pack.log; exit 1; }
TGZ="$(ls -t "$ROOT"/kaiban-distributed-*.tgz 2>/dev/null | head -1)"
[ -n "$TGZ" ] || { echo "FAIL: no tarball produced"; exit 1; }
echo "  tarball: $(basename "$TGZ")"

echo "── Tarball must be core-only (no examples/board/tests; Apache LICENSE) ──"
if tar -tzf "$TGZ" | grep -qE '(^|/)(examples|board|tests)/'; then
  echo "FAIL: tarball leaks examples/board/tests:"; tar -tzf "$TGZ" | grep -E '(^|/)(examples|board|tests)/'; exit 1
fi
echo "  core-only OK"

echo "── Fresh consumer install + import both entry points ───────────────────"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null 2>&1
npm install "$TGZ" >/tmp/smoke-install.log 2>&1 || { echo "FAIL: install"; tail -15 /tmp/smoke-install.log; exit 1; }

cat > smoke.cjs <<'EOF'
const root = require('kaiban-distributed');
const shared = require('kaiban-distributed/shared');
const want = {
  'kaiban-distributed': ['WorkflowOrchestrator', 'dispatchToAgent', 'AGENT_CHANNEL_PREFIX'],
  'kaiban-distributed/shared': [
    'createDriver', 'getDriverType', 'CompletionRouter', 'startAgentNode',
    'waitForHITLDecision', 'workflowBudgetFromEnv', 'assertWithinBudget', 'dispatchToAgent',
  ],
};
const mods = { 'kaiban-distributed': root, 'kaiban-distributed/shared': shared };
const missing = [];
for (const [m, names] of Object.entries(want))
  for (const n of names)
    if (typeof mods[m][n] === 'undefined') missing.push(`${m}#${n}`);
if (missing.length) { console.error('MISSING EXPORTS:', missing.join(', ')); process.exit(1); }
console.log('SMOKE OK: both entry points import; all required exports resolve');
EOF
node smoke.cjs
echo "── Consumer smoke PASSED ───────────────────────────────────────────────"
