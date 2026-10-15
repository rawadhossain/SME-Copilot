# ingest/documents

Safe document reading (ADR-013): an order or a supplier quote becomes structured data the owner must confirm.

1. `extract.ts`: ONE quarantined model call through `src/ai` (no tools, structured output only, the document is untrusted data).
2. `validate.ts`: pure deterministic checks of the model's claims against the text (verbatim evidence, amounts present and parsed with the money parsers, consistent totals, real dates, relative timing resolved from an explicit asOf) plus an independent suspicious-text scan.
3. Owner confirmation (`confirm.ts`, owner-only, logged in the hash-chained action log).
4. `map.ts`: a deterministic mapper from a CONFIRMED extraction to CommitmentEvents for the scenario engine.

Other files: `schema.ts` (what the model must return), `prompt.ts` (quarantine prompt), `scripted.ts` (mock provider responses, not model output), `store.ts` (database), `fixtures.ts` (the injected-instructions test fixture).

Flags: errors make the extraction `failed` (cannot be confirmed, nothing mapped); warnings (low confidence, suspicious text) go to the owner. Check it with `bun run check:extract`.
