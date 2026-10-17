// Pure: the heading a plan gets in the comparison. Kept apart from the React parts so a check script can test it.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** "Recommended" only when it is the engine's top-ranked plan AND it can run AND it keeps the cushion; otherwise the label says what it is. */
export function planLabel(p: any, i: number, reserveMinor: string | null): string {
  if (p.source === "owner") return "Your edit";
  const clean = !(p.blockers?.length) && !(p.checks ?? []).some((c: any) => c.decision === "deny");
  const keeps = reserveMinor === null || BigInt(p.metrics.minBalanceMinor) >= BigInt(reserveMinor);
  return i === 0 && clean && keeps ? "Recommended" : i === 0 && clean ? "Best available" : `Alternative ${i}`;
}
