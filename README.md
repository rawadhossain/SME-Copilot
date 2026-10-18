# Ledgerhand: a finance agent that acts inside limits you sign

**FinTechathon 2026, Topic E.** An agent for owner-run small businesses that does not only advise. It watches the cash forecast, finds a shortage, investigates, proposes plans, and, once the owner signs, negotiates with suppliers, buyers and lenders and schedules the payments and receipts, **only inside the limits the owner signed**. Every step is gated, independently verified and written to a tamper-evident log.

> All data is **synthetic**. The bank, customers, suppliers and lenders are a sandbox (a fake bank and simulated counterparties). No real money, no real credentials.

## The idea in one picture

```
 documents / books           ┌───────────────────────── deterministic code (no AI) ─────────────────────────┐
 (untrusted text)            │                                                                                │
      │                      │  cash engine ──► forecast ──► shortage detector                                │
      ▼                      │       ▲                              │                                         │
 quarantined reader ──► verified claims ──► YOU confirm              ▼                                         │
 (AI, no tools)              │                                read-only planner (AI + engine tools)           │
                             │                                 proposes plans: every number from the engine   │
                             │                                              │                                  │
                             │      YOU sign one plan (password + 2nd approver) = Ed25519 signature           │
                             │      over the plan, exact requests, bounds, expiry and mandate version         │
                             │                                              ▼                                  │
                             │   executor ──► permission GATE (pure function, re-checks the signed mandate    │
                             │   (negotiate, schedule,   and the projected balance before EVERY action)       │
                             │    roll back)                                │                                  │
                             │                                              ▼                                  │
                             │   sandbox bank + simulated counterparties ──► independent VERIFIER recomputes │
                             │                                               the forecast from what was agreed │
                             │   everything ──► append-only, hash-chained log ──► offline-verifiable export   │
                             └────────────────────────────────────────────────────────────────────────────────┘
```

The AI never does arithmetic that matters and never decides what is allowed. It investigates and proposes; **code decides, the owner signs, a separate verifier checks**.

## Run with Docker (one command)

Prerequisite: Docker only (no Node, Bun or `.env` needed).

```bash
docker compose up --build
```

This builds the app, starts PostgreSQL and the app, migrates, seeds the synthetic company at its **pinned date (2026-10-15)**, creates the demo accounts and signs the demo mandate, then serves the offline demo (the real model's recorded answers, an empty key, no network). When the log says `Ready`, open http://localhost:3000 and sign in as **owner@mercer-vale.example / Ledger-Owner-2026**.

- Another host port is a one-line override: `APP_PORT=3300 DB_PORT=55432 docker compose up --build` (defaults: `APP_PORT=3000`, `DB_PORT=5432`). If port 5432 is already in use or reserved on your machine, change `DB_PORT`; nothing inside the stack uses the host's 5432.
- Restarting is safe: every setup step is idempotent (it prints "Already seeded", "exists", "already active") and the data stays in the `pgdata` volume. `docker compose down` keeps the data; `docker compose down -v` wipes it.
- All keys in `docker-compose.yml` are the same **development-only** values as `.env.example` (a throwaway signing key pair for synthetic data).

## Run the demo from source (offline: no key, no network)

Prerequisites: Node.js 20+, [Bun](https://bun.sh) 1.3+, Docker (running).

```bash
bun install
cp .env.example .env            # PowerShell: Copy-Item .env.example .env   (contains a DEVELOPMENT signing key pair)
bun run db:up                   # PostgreSQL in Docker
bun run db:migrate
bun run db:seed                 # the synthetic company (Mercer & Vale Packaging Ltd)
bun run auth:seed               # demo accounts
bun run mandate:v2              # signs the demo mandate (80,000 per payment) with the dev key
bun run demo                    # http://localhost:3000, replaying the canonical recordings
```

Sign in as **owner@mercer-vale.example / Ledger-Owner-2026**. The second approver (for large payments) is **finance@mercer-vale.example / Ledger-Approver-2026**. Click **Start a fresh demo** (a new flagged copy of the company, so the story can be replayed as often as you like; nothing existing is changed). The click-by-click story is in [docs/demo-script.md](docs/demo-script.md).

`bun run demo` replays the real model's recorded answers (`fixtures/llm-recordings-live`) with an empty key; `DEMO_MODE=mock bun run demo` uses the scripted mock provider instead. To use a live model, put `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` in `.env` (never commit it) and run `bun run dev`.

## Checks

| Command | What it covers |
|---|---|
| `bun run lint`, `bun run typecheck` | style, types, and the layering rules (the agent cannot import signing, approval or write code) |
| `bun run check:money / engine / sandbox / gate / extract / agent / plan` | money maths, cash engine, sandbox, permission gate, document reader, planner, plan authorisation → execution → verification |
| `bun run db:verify-chain` | the hash chain of the action log |
| `bun run e2e:smoke` | the whole story through the real HTTP routes: sign-in security, CSRF, rate limit, documents, shortage, signing with step-up, buyer refusal, re-plan, execution, verification, scoreboard, evidence export. `REPLAY=1` runs it on the canonical recordings (must plan with the model's recorded answers); `RECORD=1` refreshes them (live calls). |
| `node scripts/verify-export.mjs evidence.json` | re-verifies an evidence export from the file alone |

## Safety model in one page

Full text: [docs/security-model.md](docs/security-model.md).

1. **Limits are signed by the owner and enforced in code.** The mandate (per-payment and daily limits, bank-balance floor, allowed proposal kinds, forbidden purposes, discount and finance caps) is an Ed25519-signed document. The permission gate is a pure function; a changed mandate, an expired one or a different business denies everything.
2. **One signature covers one plan.** It binds the levers, the exact requests and the worst counter-offer accepted in advance, the expiry and the mandate version and hash. Edit anything afterwards and execution refuses. Signing needs your password again; large payments need a second approver.
3. **The gate runs before every action**, projects the balance on the payment date from the cash engine and the receipts already agreed, and cannot be argued with: documents, emails and counterparty replies are untrusted data, never instructions (tested with hostile text).
4. **Nothing is half-applied.** A refusal or failure withdraws what was agreed (compensation, logged). Payments and receipts stay scheduled until the bank's end-of-day job so they can be withdrawn.
5. **An independent verifier** recomputes the forecast from what the sandbox actually holds and compares it with what the agreed terms should give. A mismatch is loud and never auto-fixed.
6. **Evidence you can check without us.** The log is append-only and hash-chained (database triggers; the app role cannot update or delete). Each case exports to a JSON bundle plus a self-verifying HTML page that re-checks the signatures and the chain offline.
7. **The agent is boxed in by lint rules and structure:** it cannot import the signing key code, the approval code, the database or any sandbox write operation; only `src/actions` writes, and only after the gate decides.

## Limits (honest)

- Sandbox only; synthetic data; the simulated counterparties are simple and deterministic.
- The owner signing key is a **development key held by the server**: anyone controlling the server could sign. Production would keep the key on the owner's device (passkey / hardware key); see the security model.
- Single-tenant demo: no account recovery, no rate limiting beyond sign-in, sessions are not device-bound.
- One real model (gpt-4o-mini) was exercised; its planning is validated by code, not trusted. Document reading handles the fixture layout, not scanned or messy documents.
- The forecast is a weekly model with stated assumptions (overdue invoices are collected after a configurable delay; the order receipt is one event). Not tax or accounting advice.

## What we would do next

Passkey/hardware-backed signing; real bank and accounting integrations behind the same gate; a larger set of counterparty behaviours and attack scenarios in the scoreboard; scanned-document extraction; multi-user roles and device-bound sessions; browser-level and accessibility testing. Deeper items are listed one line each in [docs/later-hardening.md](docs/later-hardening.md).

## Layout

`src/engine` cash engine and plan search · `src/gate` mandate, signing, permission gate · `src/actions` pipeline, executor, verifier, shortage trigger, scoreboard · `src/agent` the read-only planner · `src/ai` provider-agnostic model gateway with record/replay · `src/sandbox` fake bank and simulated counterparties · `src/ingest` documents and imports · `src/auth` login · `src/export` evidence export · `src/app` the decision room · `fixtures` synthetic documents and recordings · `docs` strategy, decisions, security model, demo script.
