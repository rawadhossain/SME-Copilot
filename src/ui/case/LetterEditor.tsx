"use client";
// The proposal letter as a document: a page you edit line by line (subject and paragraphs), with the generated terms locked underneath. The wording is
// free text; the terms block is built from the signed terms and cannot be edited here. A warning (never a block) appears if the wording mentions a
// figure that is not among the terms.
import { useEffect, useRef, useState } from "react";
import { Btn, Chip } from "../kit";
import { figureMismatches, type Letter } from "@/domain/letter-text";

function AutoText({ value, onChange, label, className = "", focus = false }: { value: string; onChange: (v: string) => void; label: string; className?: string; focus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focus) ref.current?.focus(); }, [focus]);
  useEffect(() => {
    const t = ref.current;
    if (t) { t.style.height = "0px"; t.style.height = `${t.scrollHeight}px`; }
  }, [value]);
  return <textarea ref={ref} rows={1} aria-label={label} value={value} onChange={(e) => onChange(e.target.value.replace(/\n+/g, " "))} className={`block w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1.5 py-1 leading-relaxed hover:border-line focus:border-accent focus:bg-white/70 focus:outline-none ${className}`} />;
}

export function LetterEditor({ letter, onChange, onReset, to, from, business, dateText, termLines }: { letter: Letter; onChange: (l: Letter) => void; onReset: () => void; to: string; from: string; business: string; dateText: string; termLines: string[] }) {
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const set = (i: number, v: string) => onChange({ ...letter, paragraphs: letter.paragraphs.map((p, k) => (k === i ? v : p)) });
  const insert = (i: number) => { onChange({ ...letter, paragraphs: [...letter.paragraphs.slice(0, i + 1), "", ...letter.paragraphs.slice(i + 1)] }); setFocusIdx(i + 1); };
  const remove = (i: number) => letter.paragraphs.length > 1 && onChange({ ...letter, paragraphs: letter.paragraphs.filter((_, k) => k !== i) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= letter.paragraphs.length) return;
    const p = [...letter.paragraphs];
    [p[i], p[j]] = [p[j], p[i]];
    onChange({ ...letter, paragraphs: p });
  };
  const mismatches = figureMismatches({ subject: letter.subject, paragraphs: letter.paragraphs.filter((p) => p.trim()) }, termLines);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-ink-soft">
        <span>Edit any line. Click a line to change it; use the small buttons beside it to add, move or remove a paragraph.</span>
        <Btn variant="ghost" onClick={onReset}>Reset to the draft</Btn>
      </div>
      <article className="rounded-lg border border-line-strong bg-white px-8 py-7 text-[15px] shadow-sm" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} aria-label={`Proposal letter to ${to}`}>
        <header className="mb-5 border-b border-line pb-3">
          <p className="text-base font-semibold tracking-wide">{business}</p>
          <p className="mt-1 text-xs text-ink-soft" style={{ fontFamily: "inherit" }}>{dateText} · from {from}</p>
          <p className="mt-3 text-sm"><span className="text-ink-soft">To: </span>{to}</p>
          <div className="mt-1 flex items-baseline gap-2"><span className="text-sm text-ink-soft">Subject:</span><AutoText value={letter.subject} onChange={(v) => onChange({ ...letter, subject: v })} label="Subject" className="font-semibold" /></div>
        </header>
        <div className="space-y-1">
          {letter.paragraphs.map((p, i) => (
            <div key={i} className="group flex items-start gap-1">
              <div className="flex-1"><AutoText value={p} onChange={(v) => set(i, v)} label={`Paragraph ${i + 1}`} focus={focusIdx === i} /></div>
              <div className="flex shrink-0 gap-0.5 pt-1 opacity-40 transition-opacity focus-within:opacity-100 group-hover:opacity-100" style={{ fontFamily: "system-ui, sans-serif" }}>
                <button type="button" aria-label={`Move paragraph ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded px-1 text-xs hover:bg-neutral-soft disabled:opacity-30">↑</button>
                <button type="button" aria-label={`Move paragraph ${i + 1} down`} disabled={i === letter.paragraphs.length - 1} onClick={() => move(i, 1)} className="rounded px-1 text-xs hover:bg-neutral-soft disabled:opacity-30">↓</button>
                <button type="button" aria-label={`Add a paragraph after paragraph ${i + 1}`} onClick={() => insert(i)} className="rounded px-1 text-xs hover:bg-neutral-soft">＋</button>
                <button type="button" aria-label={`Delete paragraph ${i + 1}`} disabled={letter.paragraphs.length <= 1} onClick={() => remove(i)} className="rounded px-1 text-xs hover:bg-danger-soft disabled:opacity-30">✕</button>
              </div>
            </div>
          ))}
        </div>
        <section className="mt-5 rounded-md border border-dashed border-line-strong bg-neutral-soft/60 px-4 py-3" style={{ fontFamily: "system-ui, sans-serif" }}>
          <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-soft">Proposed terms <Chip tone="neutral">locked: generated from your signed terms</Chip></p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">{termLines.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
        <p className="mt-4 text-xs text-ink-soft" style={{ fontFamily: "system-ui, sans-serif" }}>Your handwritten signature and a reference line are added when you sign.</p>
      </article>
      {mismatches.length > 0 && (
        <p role="status" className="mt-2 rounded-lg border border-caution/40 bg-caution-soft px-3 py-2 text-xs text-caution">
          The wording mentions {mismatches.join(", ")}, which {mismatches.length === 1 ? "is" : "are"} not among the terms below. You can still send it, but the terms block is what counts if the two differ.
        </p>
      )}
    </div>
  );
}
