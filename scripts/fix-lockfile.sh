#!/usr/bin/env sh
# scripts/fix-lockfile.sh — rewrite package-lock.json (root and board/) so that `npm ci`
# accepts it on npm 10 AND npm 11.
#
# Why: npm 11 (which Dependabot uses) leaves out some optional and nested entries that
# npm 10 still requires, so a lockfile written by npm 11 makes `npm ci` on npm 10 fail
# with "Missing: <pkg>@<version> from lock file". CI and the Dockerfile use npm 11.17.0
# for that reason; a lockfile written by npm 10 is accepted by both, so this script
# writes with npm 10 and lets a contributor on Node 22's bundled npm run `npm ci` too. This script always uses one pinned npm 10 through npx, whatever npm
# is installed locally, installs nothing into node_modules and runs no install scripts.
#
# Usage:   sh scripts/fix-lockfile.sh            # rewrite, then prove npm ci on 10 and 11
#          sh scripts/fix-lockfile.sh --check    # prove only; exit 1 if a lockfile needs fixing
# It never commits; it prints the git commands when a lockfile changed.
set -eu

NPM10="npm@10.9.8"
NPM11="npm@11.17.0"   # the npm that CI, the Dockerfile and Dependabot use (packageManager)
MODE="${1:-fix}"
cd "$(dirname "$0")/.."

ci_ok() { # $1 = npm spec, $2 = directory
  (cd "$2" && npx -y "$1" ci --ignore-scripts --dry-run --no-audit --no-fund >/dev/null 2>&1)
}

status=0
changed=""
for dir in . board; do
  [ -f "$dir/package-lock.json" ] || continue
  if [ "$MODE" != "--check" ]; then
    before=$(cksum < "$dir/package-lock.json")
    (cd "$dir" && npx -y "$NPM10" install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null)
    after=$(cksum < "$dir/package-lock.json")
    [ "$before" = "$after" ] || changed="$changed $dir/package-lock.json"
  fi
  for spec in "$NPM10" "$NPM11"; do
    if ci_ok "$spec" "$dir"; then
      echo "ok:   npm ci ($spec) accepts $dir/package-lock.json"
    else
      echo "FAIL: npm ci ($spec) rejects $dir/package-lock.json"; status=1
    fi
  done
done

if [ -n "$changed" ]; then
  echo
  echo "Rewritten:$changed"
  echo "Review and commit:"
  echo "  git diff --stat$changed"
  echo "  git add$changed && git commit -m \"chore(deps): rewrite lockfile with npm 10 so npm ci passes on npm 10 and 11\""
fi
exit $status
