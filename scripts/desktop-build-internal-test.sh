#!/usr/bin/env bash
# desktop-build-internal-test.sh — the ONE-PASTE build + verify + receipt chain
# for an UNSIGNED internal-test DMG (Kari's dated call, 2026-09-11: unsigned is
# accepted for known, trusted internal testers of the Finnish pilot).
#
#   bash scripts/desktop-build-internal-test.sh            # full chain
#   REUSE_PG=1 bash scripts/desktop-build-internal-test.sh # keep the staged PG payload
#   PG_FROM=/path/to/pg16 bash scripts/…                   # if PG autodetect misses
#
# The chain acts AND prints its own evidence (the deploy-state-receipt rail in
# CLAUDE.md): every step's receipt is in the transcript, and the final
# release receipt JSON lands next to the DMG. It REFUSES to build from a
# dirty tree or from a commit that is not on origin/main — the packaged
# build identity must name the merged source.
#
# macOS + Apple Silicon only (the builder targets arm64; the PG stager needs
# otool/install_name_tool/codesign).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
say() { printf '\n== %s\n' "$*"; }

say "preflight"
[ "$(uname -s)" = Darwin ] || { echo "REFUSE: this chain runs on macOS (found $(uname -s))"; exit 2; }
[ "$(uname -m)" = arm64 ] || echo "WARNING: host is $(uname -m); the builder targets arm64 only"
sw_vers 2>/dev/null || true
git status -sb | head -3
git fetch origin main
HEAD_SHA=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "REFUSE: uncommitted changes — the build identity would be dirty. Commit or stash first:"
  git status --short | head -20
  exit 2
fi
if ! git merge-base --is-ancestor "$HEAD_SHA" origin/main; then
  echo "REFUSE: HEAD $HEAD_SHA is not on origin/main — check out merged main (git checkout main && git pull) and retry"
  exit 2
fi
MAIN_SHA=$(git rev-parse origin/main)
if [ "$HEAD_SHA" != "$MAIN_SHA" ] && [ "${ALLOW_BEHIND_MAIN:-0}" != 1 ]; then
  echo "REFUSE: HEAD $HEAD_SHA is behind origin/main ($MAIN_SHA) — the build must carry CURRENT merged main (git pull --ff-only origin main), or ALLOW_BEHIND_MAIN=1 to build this older commit on purpose"
  exit 2
fi
# Commits this build MUST carry (the Finnish display fixes, PR #2101 —
# document dates shifting a day, queued/running work shown as Stalled).
# A DMG built without them would ship the bugs the pilot is meant to test
# against; extend the list when a later prerequisite lands.
for required in e2ecff2ac991cda3a955d649536e5eb21d66114c; do
  if ! git merge-base --is-ancestor "$required" HEAD; then
    echo "REFUSE: required commit $required (PR #2101, Finnish display fixes) is not in HEAD — pull current main"
    exit 2
  fi
  echo "required commit present: ${required:0:12} (PR #2101)"
done
git log --oneline -1
echo "node $(node -v) · npm $(npm -v)"
VERSION=$(node -p 'require("./package.json").version')
echo "version (root package.json): $VERSION"

say "install + build the UI (the package carries a FROZEN dist/)"
npm ci
npm run build
ls -la dist/index.html

say "stage the bundled Postgres 16 payload"
if [ "${REUSE_PG:-0}" = 1 ] && [ -f desktop/vendor/pg16/manifest.json ]; then
  echo "REUSE_PG=1 — keeping desktop/vendor/pg16 ($(node -p 'require("./desktop/vendor/pg16/manifest.json").version'))"
else
  if [ -n "${PG_FROM:-}" ]; then
    node scripts/desktop-stage-pg.mjs --from "$PG_FROM"
  else
    node scripts/desktop-stage-pg.mjs
  fi
fi

say "package (unsigned lane)"
( cd desktop && npm ci && npm run dist:mac:unsigned )

APP="dist-desktop/mac-arm64/Donna.app"
DMG="dist-desktop/Donna-${VERSION}-arm64.dmg"
[ -d "$APP" ] || { echo "REFUSE: $APP not produced"; exit 1; }
[ -f "$DMG" ] || { echo "REFUSE: $DMG not produced (check dist-desktop/ for the actual name)"; ls -la dist-desktop; exit 1; }

say "verify the bundle (payload shas, dylib closure, relocation smoke, code seal intact)"
node scripts/desktop-verify-bundle.mjs --app "$APP" --unsigned

say "release receipt (identity agreement + hygiene + sha256)"
node scripts/desktop-release-receipt.mjs --app "$APP" --dmg "$DMG"

say "done"
echo "DMG:     $REPO/$DMG"
echo "receipt: $REPO/$DMG.receipt.json"
shasum -a 256 "$DMG" | tee "$DMG.sha256"
echo "source:  $(git rev-parse --abbrev-ref HEAD) @ $HEAD_SHA (== origin/main)"
echo "next:    the clean-install validation — docs/desktop-fi-internal-test-2026-09-11.md §B (quarantine stamp first, §B.2)"
