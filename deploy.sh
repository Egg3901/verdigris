#!/usr/bin/env bash
# Build and publish Verdigris to lakesidegames.net/games/verdigris/
#
# This does NOT bake the art. public/atlas-*.png are committed artifacts, exactly
# as Rialto does it, so a deploy never needs Pillow and the art is reproducible
# from a known input. Regenerate with `npm run bake`.
set -euo pipefail
cd /root/projects/verdigris
npm run build
mkdir -p /var/www/verdigris
rsync -a --delete dist/ /var/www/verdigris/
echo "Deployed to https://lakesidegames.net/games/verdigris/"
