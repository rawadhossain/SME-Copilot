# db

Postgres connection (Drizzle, app role) and schema. `queries.ts` holds the read-only queries used by the summary API and `/demo`. Money columns are integer minor units with a currency column referencing `currencies`. `action_records` is append-only and hash-chained (ADR-004).
