"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Copilot: one place to talk to your books. A sentence goes to the server, which turns it into a typed request, validates it and runs the existing
// read-only engines; every answer is written by code from their results. The browser does no money arithmetic and nothing here can act: it can only
// ask, and open links. The conversation lives in this component's state (the previous scenario goes back with the next question for follow-ups).
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Btn, Chip, ErrorNote, inputClass } from "./kit";
import { money } from "./format";
import { call, useSession } from "./session";
import { ASK_EXAMPLE_CHIPS } from "@/lib/ask-suggestions";

interface Turn { id: number; role: "you" | "copilot"; text: string; result?: any }
let turnId = 1;

export function Copilot({ autoFocus = false }: { autoFocus?: boolean }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<any[] | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [turns, busy]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  async function send(text: string) {
    const message = text.trim();
    if (!biz || !message || busy) return;
    setBusy(true); setError(null); setInput("");
    setTurns((t) => [...t, { id: turnId++, role: "you", text: message }]);
    const r = await call(`/api/business/${biz}/copilot`, { message, ...(previous ? { previous: { events: previous } } : {}) });
    setBusy(false);
    if (!r.ok) { setError(r.data?.error === "Invalid request" ? "That could not be read. Please keep it to one short sentence." : (r.data?.error ?? "Copilot could not answer just now. Please try again in a moment.")); return; }
    if (r.data.scenario?.raw) setPrevious(r.data.scenario.raw);
    else if (r.data.kind === "scenario") setPrevious(null);
    setTurns((t) => [...t, { id: turnId++, role: "copilot", text: r.data.answerText, result: r.data }]);
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <p className="text-sm text-ink-soft">Ask about your cash, try a “what if”, or ask where something is. Copilot only reads your books and explains; it can never pay, sign, send or approve anything.</p>
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Example questions">
          {ASK_EXAMPLE_CHIPS.map((s) => <button key={s} type="button" disabled={busy} onClick={() => void send(s)} className="rounded-full border border-line-strong bg-panel px-3 py-1 text-xs text-ink-soft hover:bg-neutral-soft disabled:opacity-50">{s}</button>)}
        </div>
      )}
      <div className="space-y-3" aria-live="polite">
        {turns.map((t) => t.role === "you"
          ? <div key={t.id} className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-white">{t.text}</div>
          : <Answer key={t.id} r={t.result} onChoose={(m) => void send(m)} busy={busy} />)}
        {busy && <p className="text-sm text-ink-soft" role="status">Working it out from your books…</p>}
        <div ref={endRef} />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <label htmlFor="copilot-input" className="sr-only">Your question</label>
        <input id="copilot-input" ref={inputRef} className={`${inputClass} flex-1`} maxLength={400} value={input} onChange={(e) => setInput(e.target.value)} placeholder="For example: what if Northgate pays 3 weeks late?" />
        <Btn type="submit" busy={busy} disabled={!biz || input.trim().length === 0}>Ask</Btn>
      </form>
      {turns.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft"><button type="button" className="underline" onClick={() => { setTurns([]); setPrevious(null); setError(null); }}>Start over</button>{previous && <span>Your next “what if” changes this scenario.</span>}</div>}
    </div>
  );
}

function Answer({ r, onChoose, busy }: { r: any; onChoose: (m: string) => void; busy: boolean }) {
  const cur = r.summary?.currency ?? "GBP";
  return (
    <div className="max-w-[95%] rounded-2xl rounded-bl-sm border border-line bg-panel p-3 text-sm">
      {r.understood.length > 0 && (
        <div className="mb-2 rounded-lg bg-white/70 p-2">
          <p className="font-medium">How I understood that:</p>
          <ul className="list-disc pl-5">{r.understood.map((u: string, i: number) => <li key={i}>{u}</li>)}</ul>
        </div>
      )}
      {r.hypothetical && <p className="mb-1"><Chip tone="caution">Hypothetical: nothing here has happened or been checked</Chip></p>}
      <p>{r.answerText}</p>
      {r.summary && r.kind === "scenario" && (
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div><dt className="text-ink-soft">Lowest balance on today&apos;s books</dt><dd className="num">{money(r.summary.liveLowestMinor, cur)} (week {r.summary.liveLowestWeek})</dd></div>
          <div><dt className="text-ink-soft">Lowest balance in this scenario</dt><dd className="num">{money(r.summary.scenarioLowestMinor, cur)} (week {r.summary.scenarioLowestWeek})</dd></div>
        </dl>
      )}
      {r.lines.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink-soft">{r.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>}
      {r.needsClarification && (
        <div className="mt-2 flex flex-wrap gap-2" aria-label="Choose one">
          {r.needsClarification.choices.map((c: any) => (
            <button key={c.label} type="button" disabled={busy || !c.message} onClick={() => c.message && onChoose(c.message)} className="rounded-full border border-line-strong bg-white px-3 py-1 text-xs hover:bg-neutral-soft disabled:opacity-50" title={c.message ? undefined : "Type the name in your question"}>{c.label.replace(/\s*\(SYNTHETIC\)/i, "")}</button>
          ))}
        </div>
      )}
      {r.links.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {r.links.slice(0, 4).map((l: any) => <Link key={l.label + l.href} href={l.href} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${l.primary ? "border-accent bg-accent text-white" : "border-line-strong bg-white text-ink"}`}>{l.label}</Link>)}
        </div>
      )}
    </div>
  );
}
