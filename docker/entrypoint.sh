#!/bin/sh
# Offline demo start: migrate, seed (pinned date 2026-10-15), demo accounts, the signed demo mandate, then the app in replay mode.
# Every step is idempotent: a restart changes nothing ("Already seeded", "exists", "already active").
set -e
echo "ledgerhand: migrating"
bun scripts/migrate.ts
echo "ledgerhand: seeding the synthetic company"
bun scripts/seed-synthetic.ts
bun scripts/seed-accounts.ts
bun scripts/mandate-v2.ts
echo "ledgerhand: starting the offline demo on port 3000 (recorded model answers, no key, no network)"
export NODE_ENV=production
exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3000
