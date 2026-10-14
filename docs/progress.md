# Progress log

## Batch 1: scaffold (2026-10-15)

- Added CLAUDE.md, docs (strategy, decisions, open questions, this log).
- Next.js (App Router, strict TS, Tailwind, ESLint, bun) with a placeholder home page.
- Module skeleton under src/ with READMEs; money helpers (bigint) and a sanity script; domain types.
- Postgres via docker-compose, Drizzle schema and one migration (12 tables), .env.example.
- Verified: typecheck, lint, money sanity, dev server returns 200, migration applied to Postgres.
- Not done by design: seed data, business logic, AI, UI beyond placeholder.

## Batch 1B: corrections (2026-10-15)

- Package manager switched to Bun (ADR-003); pnpm files removed; scripts run with bun.
- Fonts now local (next/font/local, Geist files committed under src/app/fonts); no external CDN.
- DB hardening (ADR-004): app role, append-only action_records with triggers, SHA-256 hash chain plus verify script, currencies table, business_id and indexes.
- Verified: install, typecheck, lint, migration, chain verification, dev server.
