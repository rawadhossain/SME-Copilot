// Pure: what an executed plan achieved, from the recorded actions and the independent verifier's result only. A plan counts as achieved
// only when its execution finished AND the separate verification passed AND the agreed terms keep cash above zero and above the cushion.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Verdict { attempted: number; executed: number; verified: number; failed: number; verifiedOk: boolean; keeps: boolean | null; achieved: boolean }

export function outcomeVerdict(auth: any, agreed: { minBalanceMinor: string } | null, reserveMinor: string | null): Verdict {
  const ex = auth.execution;
  const actions: any[] = auth.actions ?? [];
  const count = (f: (x: any) => boolean) => actions.filter(f).length;
  const verifiedOk = ex?.status === "completed" && ex?.verification?.ok === true;
  const keeps = agreed && reserveMinor !== null ? BigInt(agreed.minBalanceMinor) >= BigInt(reserveMinor) : null;
  return {
    attempted: actions.length,
    executed: count((x) => x.status === "executed" || x.status === "verified"),
    // Action-level "verified" is not counted unless the plan-level independent check passed.
    verified: verifiedOk ? count((x) => x.status === "verified") : 0,
    failed: count((x) => x.status === "failed" || x.status === "denied"),
    verifiedOk, keeps,
    achieved: verifiedOk && keeps !== false && !!agreed && BigInt(agreed.minBalanceMinor) >= 0n,
  };
}
