// Proposal letters and the drawn signature for a plan authorisation (Batch 14). Server side only.
//  - draftLetters: a professional first draft per counterparty, written by CODE from the signed terms (no model), for the owner to edit.
//  - termLinesFor: the locked terms block that is appended to every letter, generated from the same terms that are hashed and signed.
//  - lettersHashOf / parseSignatureImage: the fingerprints that go into the owner-signed message.
//  - messageBody: the exact text sent to a counterparty (letter + locked terms + reference), rebuilt from the signed authorisation.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { canonicalize } from "@/gate/canonical";
import { requestSchema } from "@/gate/request";
import { formatMoney, money } from "@/lib/money";
import { lettersSchema, renderLetterText, type Letter, type Letters } from "@/domain/letter-text";
import type { PlanTerms, TermsEntry } from "./plan-terms";

const sha = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;

export const lettersHashOf = (letters: Letters): string => sha(canonicalize(letters));

export interface LetterCounterparty { id: string; name: string; role: string }

const counterpartyOf = (e: TermsEntry): string => {
  const r = requestSchema.parse(e.request);
  return r.kind === "sandbox.send_proposal" ? r.counterpartyId : r.kind === "sandbox.submit_application" ? r.lenderId : "";
};

/** The locked terms lines for one entry (what the counterparty is asked, and the worst the owner has pre-agreed to accept). */
function termLine(e: TermsEntry, currency: string, invoiceAmountMinor?: bigint): string[] {
  const l = e.lever;
  const b = e.bound;
  const gbp = (minor: string | bigint) => formatMoney(money(BigInt(minor), currency), 2);
  switch (l.kind) {
    case "supplier_reduce_deposit": return [`Deposit: ${pct(l.percentBps)} of the order value, payable on acceptance${b.kind === "supplier_reduce_deposit" && b.maxPercentBps > l.percentBps ? ` (we would accept up to ${pct(b.maxPercentBps)})` : ""}`];
    case "supplier_defer_balance": return [`Balance: payable ${l.daysAfterShipment} days after shipment${b.kind === "supplier_defer_balance" && b.minDays < l.daysAfterShipment ? ` (we would accept down to ${b.minDays} days)` : ""}`];
    case "buyer_request_deposit": return [`Deposit: ${pct(l.percentBps)} of the order value, payable on acceptance${b.kind === "buyer_request_deposit" && b.minPercentBps < l.percentBps ? ` (we would accept down to ${pct(b.minPercentBps)})` : ""}`];
    case "finance_invoice": {
      const r = requestSchema.parse(e.request);
      const amount = invoiceAmountMinor !== undefined ? gbp(invoiceAmountMinor) : r.kind === "sandbox.submit_application" ? gbp(r.invoiceAmountMinor) : "";
      return [`Invoice-finance advance: ${pct(l.advanceBps)} of an invoice of ${amount}`, `Fee: up to ${pct(b.kind === "finance_invoice" ? b.maxFeeBps : 0)} of the invoice`];
    }
    case "chase_overdue": return [`Overdue invoices: payment within ${l.payWithinDays} days`];
    case "early_payment_discount": return [`Early payment: a ${pct(l.discountBps)} discount for settlement ${l.daysEarly} days earlier${b.kind === "early_payment_discount" && b.maxDiscountBps > l.discountBps ? ` (up to ${pct(b.maxDiscountBps)} considered)` : ""}`];
  }
}

export function termLinesFor(terms: PlanTerms, currency: string, invoiceAmountMinor?: bigint): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of terms.entries) (out[counterpartyOf(e)] ??= []).push(...termLine(e, currency, e.lever.kind === "finance_invoice" ? invoiceAmountMinor : undefined));
  return out;
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** A professional first draft, per counterparty, from the terms. Plain sentences the owner can change freely. */
export function draftLetters(input: { terms: PlanTerms; counterparties: LetterCounterparty[]; business: string; owner: string; expiresAt: string; currency: string }): Letters {
  const { terms, counterparties, currency } = input;
  const business = input.business.replace(" (SYNTHETIC)", "");
  const valid = dateText(input.expiresAt);
  const letters: Letters = {};
  const byCp = new Map<string, TermsEntry[]>();
  for (const e of terms.entries) byCp.set(counterpartyOf(e), [...(byCp.get(counterpartyOf(e)) ?? []), e]);
  for (const [cpId, entries] of byCp) {
    const cp = counterparties.find((c) => c.id === cpId);
    if (!cp) continue;
    const name = cp.name.replace(" (SYNTHETIC)", "");
    const kinds = new Set(entries.map((e) => e.lever.kind));
    const lever = <K extends TermsEntry["lever"]["kind"]>(k: K) => entries.find((e) => e.lever.kind === k)?.lever as Extract<TermsEntry["lever"], { kind: K }> | undefined;
    const paragraphs: string[] = [`Dear ${name} team,`];
    let subject = "Proposal to revise payment terms";
    if (cp.role === "supplier") {
      paragraphs.push("Thank you for your recent quotation. Following a review of our cash position and upcoming commitments, we would like to propose a small adjustment to the payment terms so that we can place this order with confidence.");
      const dep = lever("supplier_reduce_deposit");
      const def = lever("supplier_defer_balance");
      if (dep) paragraphs.push(`We would be grateful if you could consider reducing the deposit payable on acceptance to ${pct(dep.percentBps)} of the order value.`);
      if (def) paragraphs.push(`We would also like to ask whether the balance could fall due ${def.daysAfterShipment} days after shipment, rather than on shipment.`);
    } else if (cp.role === "lender") {
      subject = "Application for invoice finance";
      const fin = lever("finance_invoice");
      const e = entries.find((x) => x.lever.kind === "finance_invoice");
      const r = e ? requestSchema.parse(e.request) : null;
      const amount = r && r.kind === "sandbox.submit_application" ? formatMoney(money(r.invoiceAmountMinor, currency), 2) : "the invoice";
      paragraphs.push("We are writing to apply for invoice finance to support our working capital while we deliver a confirmed customer order.");
      if (fin) paragraphs.push(`We would like to request an advance of ${pct(fin.advanceBps)} against an invoice of ${amount}, subject to your standard terms and any fee that falls within the limit set out below.`);
    } else {
      subject = kinds.has("chase_overdue") && !kinds.has("buyer_request_deposit") ? "Overdue invoices and payment timing" : "Proposal regarding deposit and payment timing";
      paragraphs.push("Thank you for your continued custom. We value the relationship and would like to agree arrangements that keep deliveries on schedule for both of us.");
      const dep = lever("buyer_request_deposit");
      const chase = lever("chase_overdue");
      const early = lever("early_payment_discount");
      if (dep) paragraphs.push(`To secure production and delivery of the order, we propose a deposit of ${pct(dep.percentBps)} of the order value, payable on acceptance.`);
      if (chase) paragraphs.push(`Our records show invoices that are now past their due date. We would appreciate settlement of these within ${chase.payWithinDays} days, and are happy to discuss any query on them.`);
      if (early) paragraphs.push(`If it suits you, we can offer a ${pct(early.discountBps)} discount on invoices that are settled ${early.daysEarly} days earlier than the agreed terms.`);
    }
    paragraphs.push(`The proposed terms are set out in full below. Please reply with your acceptance, or with a counter-proposal if a different arrangement would work better for you. This proposal remains open until ${valid}.`);
    paragraphs.push("Kind regards,");
    paragraphs.push(`${input.owner}, ${business}`);
    letters[cpId] = { subject, paragraphs };
  }
  return letters;
}

// ---- the drawn signature
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_SIGNATURE_BYTES = 250_000;

export type SignatureCheck = { ok: true; hash: string; bytes: number } | { ok: false; reason: string };

/** A signature must be a real PNG data URL of a sensible size with actual ink in it (a blank canvas is refused). */
export function parseSignatureImage(dataUrl: string): SignatureCheck {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return { ok: false, reason: "The signature must be a PNG image" };
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, reason: "The signature image is too large" };
  if (bytes.length < 80 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, reason: "The signature is not a valid PNG image" };
  // Walk the chunks, read the size, and look for ink in the decompressed pixel data.
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString("latin1", off + 4, off + 8);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    off += 12 + len;
  }
  if (width < 100 || height < 40 || width > 2000 || height > 1000) return { ok: false, reason: "The signature image has an unexpected size" };
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return { ok: false, reason: "The signature image could not be read" }; }
  let ink = 0;
  for (const b of raw) if (b !== 0) ink++;
  if (ink < 40) return { ok: false, reason: "Please draw your signature" };
  return { ok: true, hash: sha(bytes), bytes: bytes.length };
}

// ---- what is actually sent
/** Rebuilds the text for one counterparty from the stored, hash-checked authorisation. Returns null when the authorisation carries no letters. */
export function messageBody(auth: { id: string; letters: unknown; lettersHash: string | null; signatureHash: string | null; approvedBy: string | null }, terms: PlanTerms, counterpartyId: string, currency: string, invoiceAmountMinor?: bigint): { ok: true; text: string } | { ok: false; reason: string } | null {
  if (!auth.letters || !auth.lettersHash) return null;
  const parsed = lettersSchema.safeParse(auth.letters);
  if (!parsed.success) return { ok: false, reason: "The stored letters are not valid" };
  if (lettersHashOf(parsed.data) !== auth.lettersHash) return { ok: false, reason: "The stored letters no longer match the signed hash" };
  const letter: Letter | undefined = parsed.data[counterpartyId];
  if (!letter) return { ok: false, reason: "No letter was signed for this counterparty" };
  const lines = termLinesFor(terms, currency, invoiceAmountMinor)[counterpartyId] ?? [];
  return { ok: true, text: renderLetterText(letter, lines, { reference: auth.id.slice(0, 8), signedBy: auth.approvedBy ?? "the owner", signatureFingerprint: auth.signatureHash ? auth.signatureHash.slice(0, 12) : null }) };
}
