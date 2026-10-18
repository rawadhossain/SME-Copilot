// The attack lab's shapes. Each attack is data plus one function that runs it against a throwaway clone and reports what the system did.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Category = "Money through the gate" | "Untrusted text" | "Plan integrity" | "Privilege" | "Evidence" | "AI output" | "Secrets";

export interface Expected {
  /** What the system should do: denied (gate), refused (an action or route says no), flagged (suspicious text caught), not_accepted, rejected (bad AI output), detected (tamper found), absent (nothing found). */
  kind: string;
  /** The reason code the system produces: a gate limit id, an ActionError code, an HTTP status, an ESLint rule id, a verifier check name. One of these when an array. */
  code: string | string[];
  /** true = the attempt must appear in the audit log; false = it is refused before anything is logged. */
  logged: boolean;
}

export interface Observed {
  kind: string;
  code: string;
  /** The system's own words (ids replaced by labels). */
  reason: string;
  /** Names of the log events the attempt added (sorted, de-duplicated). */
  events: string[];
  moneyUnchanged: boolean;
  nothingSignedOrExecuted: boolean;
}

export interface Baseline {
  /** "moved" (money left the bank), "none" (the executor applied it but no money moved), "n/a" (not a money movement). */
  outcome: "moved" | "none" | "n/a";
  movedMinor: bigint;
  note: string;
}

export interface Attack {
  id: string;
  category: Category;
  /** Plain words, what the attacker tried. */
  title: string;
  /** The threat in one line. */
  threat: string;
  setup: string;
  attack: string;
  expected: Expected;
  /** True when the same request, applied without the gate, could move money (these get a without-the-gate run). */
  moneyAttack: boolean;
  run: (h: any) => Promise<Observed>;
  /** Without the permission gate: the same request applied by a test double straight to the sandbox. */
  baseline?: (h: any) => Promise<Baseline>;
}

export interface Result {
  id: string;
  category: Category;
  title: string;
  threat: string;
  expected: Expected;
  observed: Observed;
  passed: boolean;
  problems: string[];
  baseline: { outcome: string; movedMinor: string; note: string } | null;
}
