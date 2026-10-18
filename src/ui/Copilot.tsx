"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Copilot: one place to talk to your books. A sentence goes to the server, which turns it into a typed request, validates it and runs the existing
// read-only engines; every answer is written by code from their results. The browser does no money arithmetic and nothing here can act: it can only
// ask, and open links. The conversation lives in this component's state (the previous scenario goes back with the next question for follow-ups).
// Other screens can ask a question on the owner's behalf with askCopilot("..."): the drawer opens and the question is sent.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Chip, DeepLink, ErrorNote, Spinner } from "./kit";
import { Icon } from "./icons";
import { money } from "./format";
import { call, useSession } from "./session";
import { ASK_EXAMPLE_CHIPS } from "@/lib/ask-suggestions";

interface Turn { id: number; role: "you" | "copilot"; text: string; result?: any }
let turnId = 1;

/** Open the Copilot drawer, optionally sending a question straight away (used by "Ask about this" buttons). */
export function askCopilot(message?: string) {
  window.dispatchEvent(new CustomEvent("open-copilot", { detail: { message } }));
}

export function Copilot({ autoFocus = false, seed }: { autoFocus?: boolean; seed?: { message: string; n: number } }) {
  const { session } = useSession();
  const biz = session?.business.id;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<any[] | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<(m: string) => Promise<void>>(async () => { /* set below */ });

  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [turns, busy]);
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  async function send(text: string) {
    const message = text.trim();
    if (!biz || !message || busy) return;
    setBusy(true); setError(null); setInput("");
    setTurns((t) => [...t, { id: turnId++, role: "you", text: message }]);
    const r = await call(`/api/business/${biz}/copilot`, { message, ...(previous ? { previous: { events: previous } } : {}) });
    setBusy(false);
    inputRef.current?.focus();
    if (!r.ok) { setError(r.data?.error === "Invalid request" ? "That could not be read. Please keep it to one short sentence." : (r.data?.error ?? "Copilot could not answer just now. Please try again in a moment.")); return; }
    if (r.data.scenario?.raw) setPrevious(r.data.scenario.raw);
    else if (r.data.kind === "scenario") setPrevious(null);
    setTurns((t) => [...t, { id: turnId++, role: "copilot", text: r.data.answerText, result: r.data }]);
  }
  useEffect(() => { sendRef.current = send; });
  useEffect(() => { if (seed?.message && seed.n > 0) void sendRef.current(seed.message); }, [seed?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {turns.length === 0 && (
          <div>
            <p className="text-[15px] text-ink-soft">Ask about your cash, try a what-if, or find a record. I read your books and explain. I cannot pay, sign, send or approve anything.</p>
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Example questions">
              {ASK_EXAMPLE_CHIPS.map((s) => (
                <li key={s}><button type="button" disabled={busy} onClick={() => void send(s)} className="press rounded-full border border-line-strong bg-white px-3.5 py-2 text-left text-sm hover:border-accent/50 hover:bg-accent-soft/60 disabled:opacity-50">{s}</button></li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t) => t.role === "you"
          ? <div key={t.id} className="fade-in ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white shadow-soft">{t.text}</div>
          : <Answer key={t.id} r={t.result} onChoose={(m) => void send(m)} busy={busy} />)}
        {busy && <p className="flex items-center gap-2 text-sm text-ink-soft" role="status"><Spinner />Reading your books…</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div ref={endRef} />
      </div>
      <div className="border-t border-line bg-panel px-5 py-3">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <label htmlFor="copilot-input" className="sr-only">Your question</label>
          <input id="copilot-input" ref={inputRef} className="h-10 w-full min-w-0 flex-1 rounded-xl border border-line-strong bg-white px-3 text-sm placeholder:text-ink-soft/60" maxLength={400} value={input} onChange={(e) => setInput(e.target.value)} placeholder="What if Northgate pays 3 weeks late?" />
          <button type="submit" disabled={!biz || busy || input.trim().length === 0} aria-label="Ask" className="press grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-white hover:bg-accent-strong disabled:bg-accent/35"><Icon name="arrow" size={16} /></button>
        </form>
        {turns.length > 0 && <p className="mt-2 flex items-center gap-3 text-xs text-ink-soft"><button type="button" className="hover:text-ink hover:underline" onClick={() => { setTurns([]); setPrevious(null); setError(null); }}>New conversation</button>{previous && <span>Your next what-if changes this scenario.</span>}</p>}
      </div>
    </div>
  );
}

function Answer({ r, onChoose, busy }: { r: any; onChoose: (m: string) => void; busy: boolean }) {
  const cur = r.summary?.currency ?? "GBP";
  const [primary, ...secondary] = [...r.links].sort((a: any, b: any) => Number(!!b.primary) - Number(!!a.primary)).slice(0, 4);
  return (
    <div className="fade-in max-w-[96%] rounded-2xl rounded-bl-md border border-line bg-white p-4 text-sm shadow-soft">
      {r.hypothetical && <p className="mb-1.5"><Chip tone="caution">Hypothetical, nothing has happened</Chip></p>}
      <p className="text-[15px] leading-relaxed">{r.answerText}</p>
      {r.summary && r.kind === "scenario" && (
        <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
          <div className="bg-panel px-3 py-2"><dt className="text-xs text-ink-soft">Lowest today · wk {r.summary.liveLowestWeek}</dt><dd className="num font-semibold">{money(r.summary.liveLowestMinor, cur)}</dd></div>
          <div className="bg-panel px-3 py-2"><dt className="text-xs text-ink-soft">Lowest in scenario · wk {r.summary.scenarioLowestWeek}</dt><dd className={`num font-semibold ${BigInt(r.summary.scenarioLowestMinor) < 0n ? "text-danger" : ""}`}>{money(r.summary.scenarioLowestMinor, cur)}</dd></div>
        </dl>
      )}
      {r.lines.length > 0 && <ul className="mt-3 space-y-1 text-ink-soft">{r.lines.slice(0, 3).map((l: string, i: number) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-soft" aria-hidden />{l}</li>)}</ul>}
      {r.lines.length > 3 && <details className="mt-1 text-ink-soft"><summary className="cursor-pointer text-accent">{r.lines.length - 3} more</summary><ul className="mt-1 space-y-1">{r.lines.slice(3).map((l: string, i: number) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-soft" aria-hidden />{l}</li>)}</ul></details>}
      {r.needsClarification && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Choose one">
          {r.needsClarification.choices.map((c: any) => (
            <button key={c.label} type="button" disabled={busy || !c.message} onClick={() => c.message && onChoose(c.message)} className="press rounded-full border border-line-strong bg-white px-3 py-1 text-xs hover:border-accent/50 hover:bg-accent-soft/50 disabled:opacity-50" title={c.message ? undefined : "Type the name in your question"}>{c.label.replace(/\s*\(SYNTHETIC\)/i, "")}</button>
          ))}
        </div>
      )}
      {primary && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href={primary.href} className="press inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-medium text-white hover:bg-accent-strong">{primary.label}<Icon name="arrow" size={14} /></Link>
          {secondary.map((l: any) => <DeepLink key={l.label + l.href} href={l.href}>{l.label}</DeepLink>)}
        </div>
      )}
      {r.understood.length > 0 && <details className="mt-3 border-t border-line pt-2 text-xs text-ink-soft"><summary className="flex cursor-pointer items-center gap-1.5"><Icon name="info" size={13} />How I understood that</summary><ul className="mt-1 list-disc pl-5">{r.understood.map((u: string, i: number) => <li key={i}>{u}</li>)}</ul></details>}
    </div>
  );
}
