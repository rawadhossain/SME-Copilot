# SME Finance Copilot

Agent for owner-run small businesses that acts in a sandbox within owner-signed limits, built on a deterministic finance foundation. 2026 Shenzhen FinTechathon, Topic E. All data is synthetic. See [docs/product-strategy.md](docs/product-strategy.md).

## Prerequisites

Node.js 20+ (tested on 26; Next.js runs on Node), Bun 1.3+, Docker (Docker Desktop running).

## Run locally

```bash
bun install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
bun run db:up                # starts PostgreSQL in Docker and waits until healthy
bun run db:migrate           # applies src/db/migrations, creates the sme_app role
bun run dev                  # http://localhost:3000
```

## Other commands

| Command | Purpose |
|---|---|
| `bun run lint` | ESLint |
| `bun run typecheck` | TypeScript (strict) |
| `bun run check:money` | Money helper sanity script |
| `bun run db:verify-chain` | Verify the action_records hash chain |
| `bun run db:generate` | After editing `src/db/schema.ts`, generate a new SQL migration |

Stop the database with `docker compose down` (add `-v` to wipe data).

The app connects as the least-privilege `sme_app` role (`APP_DATABASE_URL`); migrations and chain verification use the owner (`DATABASE_URL`). See ADR-004.

## Layout

`src/lib/money`, `src/domain`, `src/engine`, `src/sandbox`, `src/gate`, `src/actionlog`, `src/agent`, `src/ingest`, `src/db`. Each has a README. Decisions are in [docs/decisions.md](docs/decisions.md).
