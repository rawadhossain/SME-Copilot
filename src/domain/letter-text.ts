// Proposal letters (Batch 14): plain text the owner writes or edits before signing, one letter per counterparty. PURE and free of Node imports, so the
// browser editor and the server use the same rules. A letter is a COVER MESSAGE: it never carries a decision. The structured terms (what the gate checks
// and the signature covers) are appended by code under it and cannot be edited here.
import { z } from "zod";

/** Collapse whitespace and drop control characters: a paragraph is one block of plain text. */
export const cleanText = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const paragraph = z.string().transform(cleanText);

export const letterSchema = z.object({
  subject: z.string().transform(cleanText).pipe(z.string().min(1, "A letter needs a subject").max(140)),
  paragraphs: z.array(paragraph).transform((p) => p.filter((x) => x.length > 0)).pipe(z.array(z.string().max(1500)).min(1, "A letter needs at least one paragraph").max(24)),
});
export type Letter = z.output<typeof letterSchema>;

export const MAX_LETTER_CHARS = 12_000;
export const lettersSchema = z.record(z.string().uuid(), letterSchema).refine((l) => Object.values(l).reduce((n, x) => n + x.subject.length + x.paragraphs.join("").length, 0) <= MAX_LETTER_CHARS, `The letters are longer than ${MAX_LETTER_CHARS} characters in total`);
export type Letters = z.output<typeof lettersSchema>;

/** The text that is actually sent: the letter, the locked terms, and a reference line. */
export function renderLetterText(letter: Letter, termLines: string[], opts: { reference: string; signedBy: string; signatureFingerprint: string | null }): string {
  return [
    `Subject: ${letter.subject}`,
    "",
    letter.paragraphs.join("\n\n"),
    "",
    "Proposed terms (generated from the owner-signed terms; these, not the wording above, are what is binding on acceptance):",
    ...termLines.map((l) => `  - ${l}`),
    "",
    `Reference ${opts.reference}. Signed by ${opts.signedBy}${opts.signatureFingerprint ? ` (handwritten signature on file, fingerprint ${opts.signatureFingerprint})` : ""}.`,
  ].join("\n");
}

// ---- A warning, never a block (the owner may write freely): figures in the wording that are not among the terms.
const FIGURE = /(?:[£$€]\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%|\d+\s?days?)/gi;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/days$/, "day");

/** Figures (percentages, day counts, amounts) written in the letter that do not appear in the terms of that counterparty. */
export function figureMismatches(letter: { subject: string; paragraphs: string[] }, termLines: string[]): string[] {
  const allowed = new Set(termLines.flatMap((l) => l.match(FIGURE) ?? []).map(norm));
  const found = [letter.subject, ...letter.paragraphs].flatMap((t) => t.match(FIGURE) ?? []);
  return [...new Set(found.filter((f) => !allowed.has(norm(f))))];
}
