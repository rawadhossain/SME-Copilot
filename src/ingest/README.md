# ingest

CSV import of one bank-export layout (`Date,Description,Amount,Balance`). `bank-statement.ts` parses and validates with per-row errors and a reconciliation, `identity.ts` builds the dedup identifier, `import.ts` writes to Postgres. See ADR-007.

Command line: `bun run import:csv -- <file> --business <id>`.
