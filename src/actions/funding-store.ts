// Saved funding offers and the contract-versus-offer check (Phase K). Offers are the owner's own typed terms, validated and recomputed by code.
// Saving replaces the active set (the old rows are archived, never edited or deleted) and writes one record to the action log with the
// fingerprints of the offers, not their text. The planning agent can read the saved set through a read-only tool (anonymised: see agent/tools).
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { businesses, fundingOffers } from "@/db/schema";
import { financingOfferSchema, type FinancingOffer } from "@/domain/financing-offer";
import { checkContract, type ContractCheck } from "@/engine";
import { toJsonValue } from "@/sandbox/proposals";
import { buildOffers, compareFundingInputSchema, offerFormSchema } from "./funding";
import { appendRecord } from "./log";
import { sha256Hex } from "./plan-terms";
import { ACTION_EVENTS, ActionError, type Db } from "./types";

const saveInputSchema = compareFundingInputSchema.pick({ offers: true });

async function currencyOf(db: Db, businessId: string): Promise<string> {
  const [b] = await db.select({ c: businesses.baseCurrency }).from(businesses).where(eq(businesses.id, businessId));
  if (!b) throw new ActionError("not_found", "Business not found");
  return b.c;
}

export interface StoredFunding {
  forms: unknown[];
  offers: FinancingOffer[];
}

/** The active saved offers, oldest first. */
export async function listFundingOffers(db: Db, businessId: string): Promise<StoredFunding> {
  const rows = await db.select().from(fundingOffers).where(and(eq(fundingOffers.businessId, businessId), isNull(fundingOffers.archivedAt))).orderBy(asc(fundingOffers.createdAt), asc(fundingOffers.label));
  return { forms: rows.map((r) => r.form), offers: rows.map((r) => financingOfferSchema.parse(r.offer)) };
}

/** Replaces the active set with these offers (validated by the same code as a comparison). An empty list is refused: archive by saving a new set. */
export async function saveFundingOffers(db: Db, businessId: string, input: unknown): Promise<{ saved: number; hashes: string[] }> {
  const { offers: forms } = saveInputSchema.parse(input);
  const offers = buildOffers(forms, await currencyOf(db, businessId));
  const hashes = offers.map((o) => sha256Hex(toJsonValue(o)));
  await db.transaction(async (tx) => {
    await tx.update(fundingOffers).set({ archivedAt: new Date() }).where(and(eq(fundingOffers.businessId, businessId), isNull(fundingOffers.archivedAt)));
    for (let i = 0; i < offers.length; i++) {
      await tx.insert(fundingOffers).values({ businessId, label: offers[i].id, offer: toJsonValue(offers[i]) as Record<string, unknown>, form: toJsonValue(forms[i]) as Record<string, unknown>, offerHash: hashes[i] });
    }
    await appendRecord(tx, { businessId, event: ACTION_EVENTS.FUNDING_OFFERS_SAVED, actor: "owner", detail: { count: offers.length, offerHashes: hashes } });
  });
  return { saved: offers.length, hashes };
}

export const contractCheckInputSchema = z
  .object({
    /** The offer as typed in the form, or the label of a saved offer. Exactly one. */
    offer: offerFormSchema.optional(),
    offerLabel: z.string().trim().min(1).max(60).optional(),
    /** The terms the lender's CONTRACT states, typed the same way. */
    contract: offerFormSchema,
  })
  .refine((v) => (v.offer === undefined) !== (v.offerLabel === undefined), "give either the offer or the label of a saved offer");

export async function checkFundingContract(db: Db, businessId: string, input: unknown): Promise<{ check: ContractCheck; offerLabel: string }> {
  const parsed = contractCheckInputSchema.parse(input);
  const currency = await currencyOf(db, businessId);
  let offer: FinancingOffer;
  if (parsed.offer) offer = buildOffers([parsed.offer], currency)[0];
  else {
    const saved = (await listFundingOffers(db, businessId)).offers.find((o) => o.id === parsed.offerLabel);
    if (!saved) throw new ActionError("not_found", "No saved offer has that name");
    offer = saved;
  }
  const contract = buildOffers([parsed.contract], currency)[0];
  return { check: checkContract(offer, contract), offerLabel: offer.id };
}
