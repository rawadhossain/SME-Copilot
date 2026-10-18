// Owner playbook settings (Batch 12). Every setting can only NARROW what the assistant may do or ADD a human step; none can widen the signed
// mandate, and the gate never reads this file. Defaults reproduce the behaviour before the playbook existed. Pure.
import { z } from "zod";
import { LEVER_KINDS, type LeverKind } from "./plan";

const leverFlags = z.strictObject(Object.fromEntries(LEVER_KINDS.map((k) => [k, z.boolean()])) as Record<LeverKind, z.ZodBoolean>);

export const playbookSchema = z
  .strictObject({
    /** false = the lever is left out of planning and the simulator. */
    levers: leverFlags,
    /** true = every plan needs a second approver, whatever the signed threshold says. */
    alwaysSecondApprover: z.boolean(),
    /** false = a shortage found when a document is confirmed does not start a planning run by itself. */
    autoPrepare: z.boolean(),
  })
  .refine((p) => LEVER_KINDS.some((k) => p.levers[k]), { message: "At least one lever must stay on, or no plan can be offered." });
export type Playbook = z.output<typeof playbookSchema>;

export const DEFAULT_PLAYBOOK: Playbook = {
  levers: Object.fromEntries(LEVER_KINDS.map((k) => [k, true])) as Record<LeverKind, boolean>,
  alwaysSecondApprover: false,
  autoPrepare: true,
};

/** A stored value that no longer validates falls back to the defaults (never to something wider than the signed mandate: the mandate still applies). */
export const parsePlaybook = (v: unknown): Playbook => {
  const p = playbookSchema.safeParse(v);
  return p.success ? p.data : DEFAULT_PLAYBOOK;
};

export const leversOff = (p: Playbook): LeverKind[] => LEVER_KINDS.filter((k) => !p.levers[k]);

/** Dotted names of the settings that differ (no values, no free text). */
export function changedKeys(a: Playbook, b: Playbook): string[] {
  const out: string[] = [];
  for (const k of LEVER_KINDS) if (a.levers[k] !== b.levers[k]) out.push(`levers.${k}`);
  if (a.alwaysSecondApprover !== b.alwaysSecondApprover) out.push("alwaysSecondApprover");
  if (a.autoPrepare !== b.autoPrepare) out.push("autoPrepare");
  return out;
}
