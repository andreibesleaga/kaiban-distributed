#!/usr/bin/env bash
#
# pack-staging.sh — build the Apache-2.0 library tarball from a clean staging dir
# so the GPL root LICENSE (the *application* license) never leaks into the
# *published library* package. (Phase 4b / ADR-011.)
#
# Why: `npm pack`/`npm publish` ALWAYS includes a root LICENSE/LICENCE file in the
# tarball, regardless of the `files` allow-list. The repo root LICENSE is GPL-3.0
# (the app/aggregate is GPL), but the published `kaiban-distributed` library is
# Apache-2.0 and must ship the Apache text as its canonical LICENSE. We assemble a
# staging directory whose only LICENSE is LICENSE-APACHE, then pack from there.
#
# Usage:
#   scripts/pack-staging.sh           # build + pack → ./<name>-<version>.tgz
#   scripts/pack-staging.sh --publish # build + `npm publish --provenance` from staging
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${ROOT}/dist-staging"
PUBLISH="${1:-}"

echo "▶ building…"
npm --prefix "$ROOT" run build

echo "▶ assembling staging dir: $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Compiled output (package.json `main`/`exports`/`files` reference dist/src).
cp -R "$ROOT/dist" "$STAGE/dist"

# Curated, license-correct files only. LICENSE-APACHE becomes the canonical LICENSE
# so the tarball carries Apache-2.0, never the root GPL text.
cp "$ROOT/LICENSE-APACHE" "$STAGE/LICENSE"
cp "$ROOT/LICENSE-APACHE" "$STAGE/LICENSE-APACHE"
for f in README.md LICENSING.md SECURITY.md CHANGELOG.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGE/$f"
done

# Stage a publish-ready package.json: drop the lifecycle `scripts` (so a publish
# from staging does not re-trigger `prepublishOnly: npm run build`, which would
# fail with no src/ present) and `devDependencies` (irrelevant to consumers).
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  delete pkg.scripts;
  delete pkg.devDependencies;
  fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n");
' "$ROOT/package.json" "$STAGE/package.json"

cd "$STAGE"
if [ "$PUBLISH" = "--publish" ]; then
  echo "▶ publishing from staging (Apache-2.0 tarball)…"
  npm publish --provenance --access public
else
  echo "▶ packing from staging…"
  npm pack --pack-destination "$ROOT"
  echo "✔ tarball written to $ROOT (LICENSE = Apache-2.0; no GPL text)"
fi
