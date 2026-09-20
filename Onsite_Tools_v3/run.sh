#!/usr/bin/env bash
# Onsite Tools v3 - Linux / macOS launcher.  ./run.sh [--lan] [--rebuild]
set -e
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 20.19+ is required: https://nodejs.org/"; exit 1; }

MODE=start
for a in "$@"; do
  [ "$a" = "--lan" ] && MODE=start:lan
  [ "$a" = "--rebuild" ] && rm -rf .next
done

[ -f node_modules/next/package.json ] || npm install --no-audit --no-fund
echo "Preparing the local database (data/onsite.db)..."
npx prisma db push >/dev/null
[ -f .next/BUILD_ID ] || npm run build

echo "Onsite Tools v3 -> http://127.0.0.1:8090"
(sleep 3; (xdg-open http://127.0.0.1:8090 || open http://127.0.0.1:8090) >/dev/null 2>&1) &
exec npm run "$MODE"
