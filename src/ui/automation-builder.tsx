"use client";
// The guided automation builder. An automation reads as one sentence: "When [trigger], only if [conditions], then [actions]". Every word you can change is a
// chip that opens a small custom picker (never a native select) with plain-words options and a one-line hint; numbers are steppers with units. A live preview
// re-runs the flow on your books after every change (a dry run: nothing is saved, sent or changed). It edits a tree and saves the graph the server validates again:
// the only things to pick are the ones in src/domain/automation.ts, so nothing here can build a step that pays, signs, approves, executes or sends.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Btn, Chip, ErrorNote, Field, inputClass, Note, Skeleton, type Tone } from "./kit";
import { Icon, type IconName } from "./icons";
import { money as fmtMoney } from "./format";
import { call, useSession } from "./session";
import {
  ACTION_TITLE, automationInputSchema, CONDITION_FITS, CONDITION_TITLE, DRAFT_FITS, isCondition, treeToGraph, TRIGGER_TITLE, WEEKDAYS,
  type Action, type ActionKind, type AutomationStatus, type Condition, type ConditionKind, type FlowGraph, type NodeResult, type Step, type Tree, type Trigger, type TriggerKind,
} from "@/domain/automation";
import { ACTION_HINT, actionSentence, CONDITION_HINT, checkSentence, flowSentence, TRIGGER_HINT, triggerSentence, WEEKDAY_NAME } from "@/domain/automation-words";
import { friendlyIssues, friendlyReply } from "@/domain/automation-friendly";

export interface Customer { id: string; name: string }
export interface EditorEnv { currency: string; exp: number; customers: Customer[] }
export interface EditorValue { name: string; tree: Tree }

let counter = 0;
const newId = () => `n${++counter}${Math.random().toString(36).slice(2, 6)}`;
const majorToMinor = (units: number, exp: number) => (BigInt(units) * 10n ** BigInt(exp)).toString();

// ---------------------------------------------------------------- the picker (a custom listbox)

export interface Opt { value: string; label: string; hint?: string; disabled?: boolean }

/** A chip that opens a listbox. Keyboard: Enter, Space or Down opens; Up/Down/Home/End move; Enter or Space picks; Escape closes and returns focus. */
function Choice({ value, options, onChange, label, children, className = "", width = "w-80" }: {
  value: string; options: Opt[]; onChange: (v: string) => void; label: string; children?: React.ReactNode; className?: string; width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useId();
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => { if (open) (list.current?.children[active] as HTMLElement | undefined)?.focus(); }, [open, active]);

  const show = () => { setActive(Math.max(0, options.findIndex((o) => o.value === value && !o.disabled))); setOpen(true); };
  const close = (refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const pick = (o: Opt) => { if (o.disabled) return; onChange(o.value); close(true); };
  const step = (from: number, d: 1 | -1) => { for (let i = from + d; i >= 0 && i < options.length; i += d) if (!options[i].disabled) return i; return from; };

  return (
    <span ref={box} className="relative inline-flex">
      <button ref={btn} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${cur?.label ?? "choose"}`} className={`pick ${className}`}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(); } }}>
        {children ?? <span>{cur?.label ?? "Choose"}</span>}
        <Icon name="chevron" size={14} className="text-ink-soft" />
      </button>
      {open && (
        <ul ref={list} role="listbox" aria-label={label} className={`glass-pop fade-in absolute left-0 top-full z-40 mt-1.5 ${width} max-w-[85vw] rounded-xl p-1`}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => step(a, 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => step(a, -1)); }
            else if (e.key === "Home") { e.preventDefault(); setActive(step(-1, 1)); }
            else if (e.key === "End") { e.preventDefault(); setActive(step(options.length, -1)); }
            else if (e.key === "Tab") setOpen(false);
          }}>
          {options.map((o, i) => (
            <li key={o.value} id={`${uid}-${i}`} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined} tabIndex={-1}
              onClick={() => pick(o)} onMouseEnter={() => !o.disabled && setActive(i)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(o); } }}
              className={`flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 outline-none ${o.disabled ? "cursor-not-allowed opacity-45" : "hover:bg-accent-soft focus-visible:bg-accent-soft"}`}>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-ink">{o.label}</span>{o.hint && <span className="mt-0.5 block text-xs leading-snug text-ink-soft">{o.hint}</span>}</span>
              {o.value === value && <Icon name="check" size={15} className="mt-0.5 shrink-0 text-accent" />}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- number inputs (steppers with units)

const stepBtn = "press grid h-8 w-8 shrink-0 place-items-center text-ink-soft hover:bg-accent-soft hover:text-accent disabled:opacity-35 disabled:hover:bg-transparent";

function Stepper({ value, min, max, onChange, label, unit }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string; unit?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const ok = /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max;
  const set = (n: number) => { setDraft(null); onChange(Math.max(min, Math.min(max, n))); };
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2">
        <span className={`inline-flex h-8 items-center overflow-hidden rounded-lg border bg-white ${ok ? "border-line-strong" : "border-danger"}`} role="group" aria-label={label}>
          <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => set(value - 1)} className={stepBtn}><span aria-hidden className="text-base leading-none">−</span></button>
          <input aria-label={label} inputMode="numeric" value={text} aria-invalid={!ok || undefined} className="num h-8 w-12 border-x border-line bg-transparent text-center text-sm outline-none"
            onChange={(e) => { setDraft(e.target.value); const v = e.target.value; if (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max) onChange(Number(v)); }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); set(value + 1); } else if (e.key === "ArrowDown") { e.preventDefault(); set(value - 1); } }} />
          <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => set(value + 1)} className={stepBtn}><span aria-hidden className="text-base leading-none">+</span></button>
        </span>
        {unit && <span className="text-sm text-ink-soft">{unit}</span>}
      </span>
      {!ok && <span role="alert" className="mt-1 text-xs text-danger">Use a whole number from {min} to {max}.</span>}
    </span>
  );
}

function toText(minor: string, exp: number): string {
  if (!minor) return "";
  if (exp === 0) return minor;
  const s = minor.padStart(exp + 1, "0");
  const frac = s.slice(-exp).replace(/0+$/, "");
  return frac ? `${s.slice(0, -exp)}.${frac}` : s.slice(0, -exp);
}
function MoneyStepper({ value, onChange, env, label }: { value: string; onChange: (minor: string) => void; env: EditorEnv; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? toText(value, env.exp);
  const re = new RegExp(`^\\d{1,12}${env.exp ? `(\\.\\d{0,${env.exp}})?` : ""}$`);
  const ok = re.test(text);
  const stepMinor = BigInt(100) * 10n ** BigInt(env.exp);
  const nudge = (d: 1 | -1) => { setDraft(null); const next = BigInt(value || "0") + (d === 1 ? stepMinor : -stepMinor); onChange((next < 0n ? 0n : next).toString()); };
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-2">
        <span className={`inline-flex h-8 items-center overflow-hidden rounded-lg border bg-white ${ok ? "border-line-strong" : "border-danger"}`} role="group" aria-label={label}>
          <button type="button" aria-label={`Decrease ${label}`} disabled={BigInt(value || "0") === 0n} onClick={() => nudge(-1)} className={stepBtn}><span aria-hidden className="text-base leading-none">−</span></button>
          <input aria-label={label} inputMode="decimal" value={text} aria-invalid={!ok || undefined} className="num h-8 w-24 border-x border-line bg-transparent px-2 text-right text-sm outline-none"
            onChange={(e) => {
              setDraft(e.target.value);
              if (!re.test(e.target.value)) return;
              const [i, f = ""] = e.target.value.split(".");
              onChange((BigInt(i) * 10n ** BigInt(env.exp) + BigInt((f + "0".repeat(env.exp)).slice(0, env.exp) || "0")).toString());
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); nudge(1); } else if (e.key === "ArrowDown") { e.preventDefault(); nudge(-1); } }} />
          <button type="button" aria-label={`Increase ${label}`} onClick={() => nudge(1)} className={stepBtn}><span aria-hidden className="text-base leading-none">+</span></button>
        </span>
        <span className="text-sm text-ink-soft">{env.currency}</span>
      </span>
      {!ok && <span role="alert" className="mt-1 text-xs text-danger">Use an amount like {env.exp ? "1000 or 1000.50" : "1000"}.</span>}
    </span>
  );
}

// ---------------------------------------------------------------- options and defaults

const SEVERITY_OPTS: Opt[] = [
  { value: "info", label: "Any severity", hint: "Even the quiet ones" },
  { value: "watch", label: "Keep an eye on this or worse", hint: "Skips the purely informational" },
  { value: "urgent", label: "Urgent only", hint: "Just the serious ones" },
];
const WEEKDAY_OPTS: Opt[] = WEEKDAYS.map((w) => ({ value: w, label: WEEKDAY_NAME[w] }));

const TRIGGER_DEFAULT = (k: TriggerKind, exp: number): Trigger => {
  switch (k) {
    case "forecast_below_cushion": return { kind: k, withinWeeks: 8 };
    case "invoice_overdue": return { kind: k, days: 7 };
    case "bill_due": return { kind: k, withinDays: 14, minAmount: majorToMinor(1000, exp) };
    case "customer_concentration": return { kind: k, overPercent: 50 };
    case "alert_raised": return { kind: k, minSeverity: "watch" };
    case "weekly_digest": return { kind: k, weekday: "mon" };
    case "document_confirmed": return { kind: k };
  }
};
const lateScenario = (c: Customer, days: number): Action => ({ kind: "run_simulation", scenario: { name: `${c.name} pays ${days} days late`.slice(0, 80), shocks: [{ kind: "customer_late", counterpartyId: c.id, days }] } });
const ACTION_DEFAULT = (k: ActionKind, env: EditorEnv): Action | null => {
  switch (k) {
    case "notify_owner": case "notify_approver": case "prepare_rescue_plans": case "add_to_digest": case "stop":
    case "suggest_financing_options": case "attach_analysis_snapshot": return { kind: k };
    case "wait": return { kind: k, days: 7 };
    case "draft_customer_reminder": return { kind: k, tone: "friendly" };
    case "run_simulation": return env.customers[0] ? lateScenario(env.customers[0], 14) : null;
  }
};
const CONDITION_DEFAULT = (k: ConditionKind, env: EditorEnv): Condition | null => {
  switch (k) {
    case "amount_over": case "shortage_depth_over": return { kind: k, amountMinor: majorToMinor(1000, env.exp) };
    case "days_overdue_over": return { kind: k, days: 14 };
    case "customer_is": return env.customers[0] ? { kind: k, customerId: env.customers[0].id } : null;
    case "balance_after_bill_below_cushion": return { kind: k };
    case "severity_at_least": return { kind: k, severity: "urgent" };
  }
};

const ACTION_KINDS: ActionKind[] = ["notify_owner", "notify_approver", "prepare_rescue_plans", "suggest_financing_options", "attach_analysis_snapshot", "run_simulation", "draft_customer_reminder", "add_to_digest", "wait", "stop"];
const actionsFor = (t: Trigger) => ACTION_KINDS.filter((k) => k !== "draft_customer_reminder" || DRAFT_FITS.includes(t.kind));
const conditionsFor = (t: Trigger) => (Object.keys(CONDITION_FITS) as ConditionKind[]).filter((k) => CONDITION_FITS[k].includes(t.kind));

/** A chain can only end with a check or a stop; nothing can follow either. */
const chainOk = (steps: Step[]) => steps.every((s, i) => i === steps.length - 1 || !(isCondition(s) || s.action.kind === "stop"));
const canExtend = (steps: Step[]) => chainOk(steps) && (steps.length === 0 || !(isCondition(steps[steps.length - 1]) || (steps[steps.length - 1] as { action: Action }).action.kind === "stop"));

function prune(steps: Step[], t: Trigger): { steps: Step[]; removed: number } {
  let removed = 0;
  const walk = (list: Step[]): Step[] => list.flatMap((s): Step[] => {
    if (isCondition(s)) {
      const checks = s.checks.filter((c) => CONDITION_FITS[c.kind].includes(t.kind));
      removed += s.checks.length - checks.length;
      if (checks.length === 0) { removed++; return []; }
      return [{ ...s, checks, yes: walk(s.yes), otherwise: walk(s.otherwise) }];
    }
    if (s.action.kind === "draft_customer_reminder" && !DRAFT_FITS.includes(t.kind)) { removed++; return []; }
    return [s];
  });
  return { steps: walk(steps), removed };
}

const stepIcon = (a: ActionKind): IconName =>
  a === "wait" ? "clock" : a === "stop" ? "close" : a === "draft_customer_reminder" ? "bill" : a === "prepare_rescue_plans" ? "plans" : a === "run_simulation" ? "ahead"
    : a === "suggest_financing_options" ? "ahead" : a === "attach_analysis_snapshot" ? "books" : "bell";

const iconBtn = "press rounded-lg p-1.5 text-ink-soft hover:bg-neutral-soft hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";

// ---------------------------------------------------------------- parameters

function Cue({ children }: { children: React.ReactNode }) { return <span className="text-[15px] text-ink-soft">{children}</span>; }

function ActionParams({ a, onChange, env }: { a: Action; onChange: (a: Action) => void; env: EditorEnv }) {
  if (a.kind === "notify_owner" || a.kind === "notify_approver") {
    const msg = a.message ?? "";
    return (
      <Field label="Add a note (optional)" hint={`${msg.length}/200`}>
        <input value={msg} maxLength={200} onChange={(e) => { const v = e.target.value.replace(/[\u0000-\u001f\u007f]/g, " "); onChange(v ? { ...a, message: v } : { kind: a.kind }); }} placeholder="Shown with the message, as plain text" className={inputClass} />
      </Field>
    );
  }
  if (a.kind === "wait") return <div className="flex flex-wrap items-center gap-2"><Cue>Wait</Cue><Stepper label="Days to wait" value={a.days} min={1} max={30} onChange={(days) => onChange({ kind: "wait", days })} unit="days" /><Cue>then look at your books again.</Cue></div>;
  if (a.kind === "draft_customer_reminder") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Cue>In a</Cue>
        <Choice label="Tone of the reminder" value={a.tone} onChange={(v) => onChange({ kind: a.kind, tone: v as "friendly" | "firm" })} width="w-64"
          options={[{ value: "friendly", label: "Friendly", hint: "Assumes it slipped their mind" }, { value: "firm", label: "Firm", hint: "Asks for payment within 7 days" }]} />
        <Cue>tone. You approve it before anything is sent.</Cue>
      </div>
    );
  }
  if (a.kind === "run_simulation") {
    const s = a.scenario.shocks[0];
    const cust = s && "counterpartyId" in s ? env.customers.find((c) => c.id === s.counterpartyId) : undefined;
    const set = (kind: "customer_late" | "customer_short", cid: string, n: number) => {
      const c = env.customers.find((x) => x.id === cid) ?? env.customers[0];
      onChange({ kind: "run_simulation", scenario: kind === "customer_late"
        ? { name: `${c.name} pays ${n} days late`.slice(0, 80), shocks: [{ kind, counterpartyId: c.id, days: n }] }
        : { name: `${c.name} pays ${n}% less`.slice(0, 80), shocks: [{ kind, counterpartyId: c.id, shortBps: n * 100 }] } });
    };
    const kind = s?.kind === "customer_short" ? "customer_short" : "customer_late";
    const n = s?.kind === "customer_short" ? Math.round(s.shortBps / 100) : s?.kind === "customer_late" ? s.days : 14;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Cue>What if</Cue>
        <Choice label="Customer" value={cust?.id ?? ""} onChange={(v) => set(kind, v, n)} width="w-64" options={env.customers.map((c) => ({ value: c.id, label: c.name }))} />
        <Choice label="What happens" value={kind} onChange={(v) => set(v as "customer_late" | "customer_short", cust?.id ?? env.customers[0].id, v === "customer_late" ? 14 : 25)} width="w-56"
          options={[{ value: "customer_late", label: "pays late by" }, { value: "customer_short", label: "pays less by" }]} />
        <Stepper key={kind} label={kind === "customer_late" ? "Days late" : "Percent less"} value={n} min={1} max={kind === "customer_late" ? 90 : 100} onChange={(v) => set(kind, cust?.id ?? env.customers[0].id, v)} unit={kind === "customer_late" ? "days" : "%"} />
        <div className="w-full"><Note>What-if: made up, nothing is changed or sent.</Note></div>
      </div>
    );
  }
  return <p className="text-sm text-ink-soft">{ACTION_HINT[a.kind]}.</p>;
}

function CheckRow({ c, onChange, onRemove, trigger, env, canRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void; trigger: Trigger; env: EditorEnv; canRemove: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Choice label="Condition" value={c.kind} width="w-96" onChange={(v) => { const d = CONDITION_DEFAULT(v as ConditionKind, env); if (d) onChange(d); }}
        options={conditionsFor(trigger).map((k) => ({ value: k, label: CONDITION_TITLE[k], hint: CONDITION_HINT[k], disabled: !CONDITION_DEFAULT(k, env) }))} />
      {(c.kind === "amount_over" || c.kind === "shortage_depth_over") && <MoneyStepper label="Amount" value={c.amountMinor} env={env} onChange={(amountMinor) => onChange({ ...c, amountMinor })} />}
      {c.kind === "days_overdue_over" && <Stepper label="Days" value={c.days} min={0} max={365} onChange={(days) => onChange({ ...c, days })} unit="days" />}
      {c.kind === "customer_is" && <Choice label="Customer" value={c.customerId} onChange={(customerId) => onChange({ ...c, customerId })} width="w-64" options={env.customers.map((x) => ({ value: x.id, label: x.name }))} />}
      {c.kind === "severity_at_least" && <Choice label="Severity" value={c.severity} onChange={(v) => onChange({ ...c, severity: v as "info" | "watch" | "urgent" })} width="w-72" options={SEVERITY_OPTS} />}
      {canRemove && <button type="button" onClick={onRemove} aria-label="Remove this condition" className={`${iconBtn} ml-auto`}><Icon name="close" size={14} /></button>}
    </li>
  );
}

// ---------------------------------------------------------------- steps

function StepList({ steps, onChange, trigger, env, label }: { steps: Step[]; onChange: (s: Step[]) => void; trigger: Trigger; env: EditorEnv; label: string }) {
  const set = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => { const next = [...steps]; [next[i], next[i + d]] = [next[i + d], next[i]]; if (chainOk(next)) onChange(next); };
  const extend = canExtend(steps);
  const addOpts: Opt[] = [
    ...actionsFor(trigger).map((k) => ({ value: k, label: ACTION_TITLE[k], hint: ACTION_HINT[k], disabled: !ACTION_DEFAULT(k, env) })),
    ...(conditionsFor(trigger).length > 0 ? [{ value: "__check", label: "Only continue if…", hint: "A condition with a yes path and an otherwise path" }] : []),
  ];
  function add(v: string) {
    if (v === "__check") {
      const k = conditionsFor(trigger).find((x) => CONDITION_DEFAULT(x, env));
      const d = k && CONDITION_DEFAULT(k, env);
      if (d) onChange([...steps, { id: newId(), mode: "all", checks: [d], yes: [], otherwise: [] }]);
      return;
    }
    const d = ACTION_DEFAULT(v as ActionKind, env);
    if (d) onChange([...steps, { id: newId(), action: d }]);
  }
  return (
    <ol aria-label={label} className="space-y-0">
      {steps.map((s, i) => (
        <li key={s.id}>
          <span aria-hidden className="mx-auto block h-3 w-px bg-line-strong" />
          {isCondition(s) ? (
            <div className="rounded-2xl border border-accent/30 bg-accent-soft/30 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="accent">Only if</Chip>
                <Choice label="All or any" value={s.mode} onChange={(v) => set(i, { ...s, mode: v as "all" | "any" })} width="w-72"
                  options={[{ value: "all", label: "all of these hold", hint: "Every condition must be true" }, { value: "any", label: "any of these holds", hint: "One true condition is enough" }]} />
                <span className="ml-auto flex items-center">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className={iconBtn}><Icon name="chevron" size={14} className="rotate-180" /></button>
                  <button type="button" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className={iconBtn}><Icon name="chevron" size={14} /></button>
                  <button type="button" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Remove this condition and what follows" className={iconBtn}><Icon name="close" size={14} /></button>
                </span>
              </div>
              <ul className="mt-3 space-y-2">
                {s.checks.map((c, ci) => <CheckRow key={ci} c={c} trigger={trigger} env={env} canRemove={s.checks.length > 1} onChange={(nc) => set(i, { ...s, checks: s.checks.map((x, j) => (j === ci ? nc : x)) })} onRemove={() => set(i, { ...s, checks: s.checks.filter((_, j) => j !== ci) })} />)}
              </ul>
              {s.checks.length < 6 && (
                <button type="button" onClick={() => { const k = conditionsFor(trigger).find((x) => !s.checks.some((c) => c.kind === x) && CONDITION_DEFAULT(x, env)); const d = k && CONDITION_DEFAULT(k, env); if (d) set(i, { ...s, checks: [...s.checks, d] }); }}
                  className="press mt-2 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-accent hover:underline"><Icon name="plus" size={13} />Add another condition</button>
              )}
              <div className="mt-4 grid gap-4">
                <div className="rounded-xl bg-white/70 p-3"><p className="text-center text-xs font-semibold text-good">Then, if yes</p><StepList label="Steps if yes" steps={s.yes} trigger={trigger} env={env} onChange={(yes) => set(i, { ...s, yes })} /></div>
                <div className="rounded-xl bg-white/70 p-3"><p className="text-center text-xs font-semibold text-ink-soft">Otherwise</p><StepList label="Steps otherwise" steps={s.otherwise} trigger={trigger} env={env} onChange={(otherwise) => set(i, { ...s, otherwise })} /></div>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-line bg-panel p-4 shadow-soft">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-neutral-soft text-ink-soft" aria-hidden><Icon name={stepIcon(s.action.kind)} size={15} /></span>
                <Cue>{i === 0 ? "Then" : "and then"}</Cue>
                <Choice label="What to do" value={s.action.kind} width="w-96" onChange={(v) => {
                  const d = ACTION_DEFAULT(v as ActionKind, env);
                  if (!d) return;
                  const next = steps.map((x, j) => (j === i ? { id: s.id, action: d } : x));
                  onChange(d.kind === "stop" ? next.slice(0, i + 1) : next);
                }} options={actionsFor(trigger).map((k) => ({ value: k, label: ACTION_TITLE[k], hint: ACTION_HINT[k], disabled: !ACTION_DEFAULT(k, env) }))} />
                <span className="ml-auto flex items-center">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className={iconBtn}><Icon name="chevron" size={14} className="rotate-180" /></button>
                  <button type="button" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className={iconBtn}><Icon name="chevron" size={14} /></button>
                  <button type="button" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Remove this step" className={iconBtn}><Icon name="close" size={14} /></button>
                </span>
              </div>
              <div className="mt-3 pl-9"><ActionParams a={s.action} env={env} onChange={(action) => set(i, { id: s.id, action })} /></div>
            </div>
          )}
        </li>
      ))}
      {extend && (
        <li>
          <span aria-hidden className="mx-auto block h-3 w-px bg-line-strong" />
          <div className="flex justify-center">
            <Choice label="Add a step" value="" onChange={add} options={addOpts} className="border-dashed text-accent"><Icon name="plus" size={13} />Add a step</Choice>
          </div>
        </li>
      )}
    </ol>
  );
}

function TriggerParams({ t, onChange, env }: { t: Trigger; onChange: (t: Trigger) => void; env: EditorEnv }) {
  switch (t.kind) {
    case "forecast_below_cushion": return <div className="flex flex-wrap items-center gap-2"><Cue>within the next</Cue><Stepper label="Weeks" value={t.withinWeeks} min={1} max={20} onChange={(withinWeeks) => onChange({ ...t, withinWeeks })} unit="weeks" /></div>;
    case "invoice_overdue": return (
      <div className="flex flex-wrap items-center gap-2">
        <Cue>by at least</Cue><Stepper label="Days overdue" value={t.days} min={1} max={120} onChange={(days) => onChange({ ...t, days })} unit="days" />
        {t.minAmount ? (
          <>
            <Cue>and worth at least</Cue><MoneyStepper label="Smallest invoice" value={t.minAmount} env={env} onChange={(minAmount) => onChange({ ...t, minAmount })} />
            <button type="button" onClick={() => onChange({ kind: t.kind, days: t.days })} aria-label="Remove the smallest-invoice limit" className={iconBtn}><Icon name="close" size={14} /></button>
          </>
        ) : <button type="button" onClick={() => onChange({ ...t, minAmount: majorToMinor(500, env.exp) })} className="press inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-accent hover:underline"><Icon name="plus" size={13} />Only above an amount</button>}
      </div>
    );
    case "bill_due": return <div className="flex flex-wrap items-center gap-2"><Cue>due within</Cue><Stepper label="Days" value={t.withinDays} min={1} max={60} onChange={(withinDays) => onChange({ ...t, withinDays })} unit="days" /><Cue>and worth at least</Cue><MoneyStepper label="Smallest bill" value={t.minAmount} env={env} onChange={(minAmount) => onChange({ ...t, minAmount })} /></div>;
    case "customer_concentration": return <div className="flex flex-wrap items-center gap-2"><Cue>owes more than</Cue><Stepper label="Percent" value={t.overPercent} min={10} max={90} onChange={(overPercent) => onChange({ ...t, overPercent })} unit="% of what you are owed" /></div>;
    case "alert_raised": return <div className="flex flex-wrap items-center gap-2"><Cue>of severity</Cue><Choice label="Severity" value={t.minSeverity} onChange={(v) => onChange({ ...t, minSeverity: v as "info" | "watch" | "urgent" })} width="w-72" options={SEVERITY_OPTS} /></div>;
    case "weekly_digest": return <div className="flex flex-wrap items-center gap-2"><Cue>on</Cue><Choice label="Day of the week" value={t.weekday} onChange={(v) => onChange({ ...t, weekday: v as (typeof WEEKDAYS)[number] })} width="w-52" options={WEEKDAY_OPTS} /></div>;
    case "document_confirmed": return null;
  }
}

// ---------------------------------------------------------------- the read-only map

function MapNode({ icon, tone, kicker, text }: { icon: IconName; tone: "good" | "accent" | "neutral"; kicker: string; text: string }) {
  const c = tone === "good" ? "text-good" : tone === "accent" ? "text-accent" : "text-ink-soft";
  return (
    <div className="mx-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-line bg-panel p-3 text-left shadow-soft">
      <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-neutral-soft ${c}`} aria-hidden><Icon name={icon} size={15} /></span>
      <span className="min-w-0"><span className={`block text-[11px] font-semibold uppercase tracking-wide ${c}`}>{kicker}</span><span className="block text-sm text-ink">{text}</span></span>
    </div>
  );
}
function MapSteps({ steps, m, names }: { steps: Step[]; m: (v: string) => string; names: (id: string) => string | undefined }) {
  return (
    <>
      {steps.map((s) => (
        <div key={s.id}>
          <span aria-hidden className="mx-auto block h-4 w-px bg-line-strong" />
          {isCondition(s) ? (
            <>
              <MapNode icon="info" tone="accent" kicker={s.mode === "all" ? "Only if all hold" : "Only if any holds"} text={s.checks.map((c) => checkSentence(c, m, names)).join(s.mode === "all" ? " and " : " or ")} />
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl bg-good-soft/50 p-2"><p className="mb-1 text-center text-xs font-semibold text-good">Yes</p>{s.yes.length ? <MapSteps steps={s.yes} m={m} names={names} /> : <p className="py-2 text-center text-xs text-ink-soft">Nothing</p>}</div>
                <div className="rounded-xl bg-neutral-soft p-2"><p className="mb-1 text-center text-xs font-semibold text-ink-soft">Otherwise</p>{s.otherwise.length ? <MapSteps steps={s.otherwise} m={m} names={names} /> : <p className="py-2 text-center text-xs text-ink-soft">Nothing</p>}</div>
              </div>
            </>
          ) : <MapNode icon={stepIcon(s.action.kind)} tone="neutral" kicker={s.action.kind === "wait" ? "Wait" : s.action.kind === "stop" ? "Stop" : "Then"} text={actionSentence(s.action)} />}
        </div>
      ))}
    </>
  );
}
/** A read-only picture of the same flow the Steps view edits. */
function FlowMap({ trigger, steps, env }: { trigger: Trigger; steps: Step[]; env: EditorEnv }) {
  const m = (v: string) => fmtMoney(v, env.currency);
  const names = (id: string) => env.customers.find((c) => c.id === id)?.name;
  return (
    <div className="surface p-5" role="img" aria-label="Map of this automation, read only">
      <MapNode icon="clock" tone="good" kicker="When" text={triggerSentence(trigger, m)} />
      <MapSteps steps={steps} m={m} names={names} />
      <p className="mt-4 text-center text-xs text-ink-soft">A picture of the same flow. Switch to Steps to change it.</p>
    </div>
  );
}

// ---------------------------------------------------------------- the live preview

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  ran: { label: "Done", tone: "good" }, would_run: { label: "Would do", tone: "accent" }, yes: { label: "Yes", tone: "good" }, otherwise: { label: "Otherwise", tone: "neutral" },
  waiting: { label: "Waiting", tone: "caution" }, would_wait: { label: "Would wait", tone: "caution" }, skipped: { label: "Skipped", tone: "neutral" }, stopped: { label: "Stopped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" }, later: { label: "Not reached", tone: "neutral" },
};
export const OutcomeChip = ({ o }: { o: string }) => { const x = OUTCOME[o] ?? { label: o, tone: "neutral" as Tone }; return <Chip tone={x.tone}>{x.label}</Chip>; };

export interface DryRun { matched: number; note: string; examples: { entity: string; title: string; body?: string; link?: string; nodes: NodeResult[] }[] }
type Preview = { key: string; state: "ready" | "error"; run?: DryRun; error?: string };

function PreviewPanel({ preview, fresh, valid, onRefresh }: { preview: Preview | null; fresh: boolean; valid: boolean; onRefresh: () => void }) {
  return (
    <div className="surface p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div><p className="display text-[17px]">Right now this would pick up</p><p className="mt-0.5 text-xs text-ink-soft">A preview on your real books. Nothing is saved, sent or changed.</p></div>
        <Btn variant="ghost" size="sm" className="shrink-0 whitespace-nowrap" onClick={onRefresh} disabled={!valid}><Icon name="refresh" size={14} />Refresh preview</Btn>
      </div>
      <div className="mt-4">
        {!valid ? <p className="text-sm text-ink-soft">Finish the steps on the left and the preview appears here.</p>
          : !fresh || !preview ? <div className="space-y-2.5" aria-busy="true"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
          : preview.state === "error" ? <ErrorNote>{preview.error}</ErrorNote>
          : preview.run && preview.run.matched === 0 ? (
            <div className="rounded-xl bg-good-soft px-4 py-3"><p className="text-sm font-medium text-good">Nothing matches today, which is good news.</p><p className="mt-0.5 text-[13px] text-ink-soft">It will run when something does.</p></div>
          ) : preview.run && (
            <>
              <p className="text-sm font-medium">{preview.run.matched} {preview.run.matched === 1 ? "match" : "matches"} right now</p>
              <ul className="mt-3 space-y-3">
                {preview.run.examples.map((ex) => (
                  <li key={ex.entity} className="rounded-xl border border-line bg-panel-quiet p-3">
                    <p className="text-sm font-medium text-ink">{ex.title}</p>
                    {ex.body && <p className="mt-0.5 text-[13px] text-ink-soft">{ex.body}</p>}
                    <ol className="mt-2 space-y-1.5 border-l border-line pl-3">
                      {ex.nodes.filter((n, i) => i > 0 && n.outcome !== "later" && n.summary).map((n) => <li key={n.node} className="flex flex-wrap items-baseline gap-2 text-[13px]"><OutcomeChip o={n.outcome} /><span className="min-w-0 text-ink-soft">{n.summary}</span></li>)}
                    </ol>
                  </li>
                ))}
              </ul>
              {preview.run.matched > preview.run.examples.length && <p className="mt-2 text-xs text-ink-soft">and {preview.run.matched - preview.run.examples.length} more</p>}
            </>
          )}
      </div>
      <div className="mt-4 border-t border-line pt-3"><Note>Sandbox. Nothing here pays, signs, approves or sends anything outside the app.</Note></div>
    </div>
  );
}

// ---------------------------------------------------------------- the builder

export function AutomationBuilder({ initial, env, busy, error, status, onSave, onCancel, onDelete }: {
  initial: EditorValue; env: EditorEnv; busy: boolean; error: string | null; status: AutomationStatus | null;
  onSave: (v: { name: string; graph: FlowGraph }, turnOn: boolean) => void; onCancel: () => void; onDelete?: () => void;
}) {
  const { session } = useSession();
  const biz = session?.business.id;
  const [name, setName] = useState(initial.name);
  const [touched, setTouched] = useState(false);
  const [trigger, setTrigger] = useState<Trigger>(initial.tree.trigger);
  const [steps, setSteps] = useState<Step[]>(initial.tree.steps);
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<"steps" | "map">("steps");
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);

  const graph = useMemo(() => treeToGraph({ triggerId: "t", trigger, steps }), [trigger, steps]);
  const check = useMemo(() => automationInputSchema.safeParse({ name, graph }), [name, graph]);
  const problems = check.success ? [] : friendlyIssues(check.error.issues);
  const graphOk = useMemo(() => automationInputSchema.safeParse({ name: "Preview", graph }).success, [graph]);
  const key = useMemo(() => JSON.stringify(graph), [graph]);
  const fresh = preview?.key === key;
  const previewed = fresh && preview?.state === "ready";
  const m = (v: string) => fmtMoney(v, env.currency);
  const sentence = useMemo(() => flowSentence(graph, (v) => fmtMoney(v, env.currency), (id) => env.customers.find((c) => c.id === id)?.name), [graph, env]);

  // Debounced dry run on every change: the preview is always for the version on screen.
  useEffect(() => {
    if (!graphOk || !biz) return;
    let dead = false;
    const t = setTimeout(async () => {
      const r = await call(`/api/business/${biz}/automations/dry-run`, { name: "Preview", graph });
      if (dead) return;
      setPreview(r.ok ? { key, state: "ready", run: r.data } : { key, state: "error", error: friendlyReply(r.data) });
    }, 450);
    return () => { dead = true; clearTimeout(t); };
  }, [key, refresh, graphOk, biz, graph]);

  function changeTrigger(t: Trigger) {
    if (t.kind === trigger.kind) { setTrigger(t); return; }
    const p = prune(steps, t);
    setTrigger(t);
    setSteps(p.steps);
    setNote(p.removed > 0 ? `${p.removed} ${p.removed === 1 ? "step does" : "steps do"} not apply to this trigger, so ${p.removed === 1 ? "it was" : "they were"} removed.` : null);
  }
  const value = { name, graph };
  const nameBad = touched && name.trim().length === 0;
  const isDraftish = status === null || status === "draft";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0 space-y-4">
        <div className="surface p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">In plain words</p>
          <p className="display mt-1 text-[19px] leading-snug" aria-live="polite">{sentence}</p>
          <div className="mt-2"><Note>It can only tell you, prepare or draft. It never pays, signs, approves or sends anything outside the app.</Note></div>
        </div>

        <Field label="Name">
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={nameBad || undefined} placeholder="For example: Chase overdue invoices" className={`${inputClass} ${nameBad ? "!border-danger" : ""}`} />
          {nameBad && <span role="alert" className="mt-1 block text-xs text-danger">Give this automation a name.</span>}
        </Field>

        <div role="tablist" aria-label="How to view this automation" className="utabs">
          {(["steps", "map"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className="utab" onClick={() => setView(v)}>{v === "steps" ? "Steps" : "Map"}</button>
          ))}
        </div>

        {view === "map" ? <FlowMap trigger={trigger} steps={steps} env={env} /> : (
          <>
            <div className="surface p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="good">When</Chip>
                <Choice label="Trigger" value={trigger.kind} width="w-96" onChange={(v) => changeTrigger(TRIGGER_DEFAULT(v as TriggerKind, env.exp))}
                  options={(Object.keys(TRIGGER_TITLE) as TriggerKind[]).map((k) => ({ value: k, label: TRIGGER_TITLE[k], hint: TRIGGER_HINT[k] }))} />
                <TriggerParams t={trigger} env={env} onChange={changeTrigger} />
              </div>
              <p className="mt-3 text-xs text-ink-soft">Runs after each check of your books, once per situation. Reads: {triggerSentence(trigger, m)}.</p>
            </div>
            {note && <p role="status" className="fade-in rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">{note}</p>}
            <StepList label="Steps" steps={steps} trigger={trigger} env={env} onChange={setSteps} />
          </>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Btn busy={busy} disabled={!check.success} onClick={() => onSave(value, false)}>{isDraftish ? "Save as draft" : "Save changes"}</Btn>
          {status !== "enabled" && <Btn variant="secondary" busy={busy} disabled={!check.success || !previewed} onClick={() => onSave(value, true)}>Save and turn on</Btn>}
          <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
          {onDelete && <Btn variant="ghost" className="ml-auto text-danger hover:bg-danger-soft" onClick={onDelete}>Delete</Btn>}
        </div>
        {problems.length > 0 ? (
          <div className="rounded-xl bg-caution-soft px-4 py-3" aria-label="What is missing">
            <p className="text-sm font-medium text-caution">To save, fix this first</p>
            <ul className="mt-1 space-y-1 text-sm text-ink-soft">{problems.map((p) => <li key={p} className="flex gap-2"><span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-caution" />{p}</li>)}</ul>
          </div>
        ) : status !== "enabled" && !previewed && <p className="text-xs text-ink-soft">Turning it on needs the preview to finish for this version. It updates by itself after each change.</p>}
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>

      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <PreviewPanel preview={preview} fresh={fresh} valid={graphOk} onRefresh={() => { setPreview(null); setRefresh((n) => n + 1); }} />
      </aside>
    </div>
  );
}
