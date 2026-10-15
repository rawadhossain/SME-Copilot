# engine/plans

Pure plan search (ADR-014): no database, clock or randomness.

- `simulate.ts` `simulateLevers`: levers to term changes (reusing `applyTermChanges`) to metrics and cost.
- `search.ts` `searchPlans`: grid enumeration, deterministic ranking, top N and Pareto set.
- `parties.ts` finds the supplier, buyer and lender in the events. `requests.ts` turns a lever into its proposal request.

No acceptance probabilities: counterparty agreement is unknown until asked.
