#!/usr/bin/env bash
# Build and publish Verdigris.
#
# This does NOT bake the art. public/atlas-*.png are committed artifacts, so a
# deploy never needs Pillow and the art is reproducible from a known input.
# Regenerate with `npm run bake`.
#
# Paths come from the environment so this file carries no host specifics:
#   VERDIGRIS_WEB_ROOT   where the built site is published (required)
#   VERDIGRIS_SITE_URL   printed on success, cosmetic only
set -euo pipefail

WEB_ROOT="${VERDIGRIS_WEB_ROOT:-}"
SITE_URL="${VERDIGRIS_SITE_URL:-the site}"

if [[ -z "$WEB_ROOT" ]]; then
  echo "VERDIGRIS_WEB_ROOT is not set. Example:" >&2
  echo "  VERDIGRIS_WEB_ROOT=/path/to/webroot ./deploy.sh" >&2
  exit 2
fi

cd "$(dirname "$0")"
npm run build
mkdir -p "$WEB_ROOT"
rsync -a --delete dist/ "$WEB_ROOT/"
echo "Deployed to $SITE_URL"
