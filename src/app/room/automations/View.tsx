"use client";
// Autopilot: what your assistant does for you in the background. A short header of numbers, what needs you, your automations (one plain sentence each),
// a day-by-day feed of what they did, and a gallery of recipes. Automations can only notify, prepare or draft: signing and sending stay with the owner.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Chip, DeepLink, Empty, ErrorNote, Loading, Metric, Modal, Note, PageHead, Skeleton, type Tone } from "@/ui/kit";
import { Icon } from "@/ui/icons";
import { ago } from "@/ui/alerts";
import { call, useSession } from "@/ui/session";
import { money } from "@/ui/format";
import { AutomationBuilder, type EditorEnv, type EditorValue } from "@/ui/automation-builder";
import { flowSentence } from "@/domain/automation-words";
import { friendlyReply } from "@/domain/automation-friendly";
import { graphToTree, type AutomationStatus, type FlowGraph, type NodeResult, type Tree } from "@/domain/automation";

interface Auto { id: string; name: string; status: AutomationStatus; version: number; graph: FlowGraph; editable: boolean; lastRun: { at: string; status: string; entity: string } | null; waiting: number; runs: number }
interface Recipe { id: string; name: string; blurb: string; tag: string; group: string; graph: FlowGraph }
interface Run { id: string; automationId: string; automationName: string; status: string; entity: string; startedAt: string; resumeOn: string | null; results: NodeResult[] }
interface Note1 { id: string; kind: string; title: string; body: string; createdAt: string; readAt: string | null; resolvedAt: string | null }
type Mode = { kind: "hub" } | { kind: "build"; id: string | null; status: AutomationStatus | null; value: EditorValue };

const FEATURED = ["cash_cushion_warning", "chase_overdue_invoices", "weekly_cash_digest"];
const TAG_TONE: Record<string, Tone> = { "Cash alerts": "caution", Collections: "accent", Financing: "good", Analysis: "neutral" };
const blankTree = (): Tree => ({ triggerId: "t", trigger: { kind: "invoice_overdue", days: 7 }, steps: [{ id: "first", action: { kind: "notify_owner" } }] });

/** Where a run's story continues. */
function runLink(r: Run): { href: string; label: string } {
  const text = r.results.map((n) => n.summary).join(" ");
  if (/Prepared \d+ /.test(text)) return { href: "/room/case", label: "Review and sign" };
  if (/Drafted/.test(text)) return { href: "#needs-you", label: "See the draft" };
  if (r.entity.startsWith("invoice:") || r.entity.startsWith("bill:")) return { href: "/room/invoices", label: "Open invoices and bills" };
  if (r.entity.startsWith("customer:")) return { href: "/room/analysis", label: "Open the analysis" };
  return { href: "/room", label: "Open Today" };
}

const dayLabel = (iso: string) => {
  const d = new Date(iso), now = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  return same(d, now) ? "Today" : same(d, y) ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** What a run found and did, in plain words. */
function story(r: Run): { found: string; did: string[] } {
  const found = (r.results[0]?.summary ?? "").replace(/^Matched:\s*/, "");
  const did = r.results.slice(1).filter((n) => ["ran", "waiting", "failed", "stopped", "skipped"].includes(n.outcome) && n.summary && !/branch$/.test(n.summary)).map((n) => n.summary);
  return { found, did };
}

function lastResult(a: Auto, runs: Run[] | null): string {
  if (a.status === "draft") return "Not turned on yet.";
  const r = runs?.find((x) => x.automationId === a.id);
  if (!r) return a.status === "enabled" ? "Watching your books. Nothing has triggered it yet." : "Off.";
  const last = story(r).did.at(-1);
  return `${ago(r.startedAt)}: ${last ?? "Matched, nothing more to do."}`;
}

export default function Automations() {
  const { session } = useSession();
  const biz = session?.business.id;
  const isOwner = session?.user.role === "owner";
  const currency = session?.business.currency ?? "GBP";
  const [data, setData] = useState<{ automations: Auto[]; templates: Recipe[] } | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [notes, setNotes] = useState<Note1[]>([]);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "hub" });
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Auto | null>(null);
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [allNeeds, setAllNeeds] = useState(false);
  const env: EditorEnv = useMemo(() => ({ currency, exp: currency === "JPY" ? 0 : 2, customers }), [currency, customers]);
  const mm = useCallback((v: string) => money(v, currency), [currency]);
  const names = useCallback((id: string) => customers.find((c) => c.id === id)?.name, [customers]);

  const load = useCallback(async () => {
    if (!biz) return;
    const [a, r, n] = await Promise.all([call(`/api/business/${biz}/automations`), call(`/api/business/${biz}/automations/runs`), call(`/api/business/${biz}/notifications`)]);
    if (a.ok) setData(a.data); else setError(friendlyReply(a.data));
    if (r.ok) setRuns(r.data.runs); else setRuns([]);
    if (n.ok) setNotes(n.data.notifications);
  }, [biz]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!biz) return;
    call(`/api/business/${biz}/simulate`).then((r) => { if (r.ok) setCustomers(r.data.customers ?? []); });
  }, [biz]);

  const flashMsg = (m: string) => { setFlash(m); setTimeout(() => setFlash(null), 5000); };
  const tellBell = () => window.dispatchEvent(new Event("notifications-changed"));

  async function toggle(a: Auto) {
    setBusy(a.id); setError(null);
    const r = await call(`/api/business/${biz}/automations/${a.id}/enabled`, { enabled: a.status !== "enabled" });
    setBusy(null);
    if (r.ok) { await load(); flashMsg(a.status === "enabled" ? `“${a.name}” is off.` : `“${a.name}” is on. It runs after each check of your books.`); } else setError(friendlyReply(r.data));
  }
  async function remove(a: Auto) {
    setBusy(a.id);
    const r = await call(`/api/business/${biz}/automations/${a.id}`, undefined, "DELETE");
    setBusy(null); setConfirmDelete(null);
    if (r.ok) { setMode({ kind: "hub" }); await load(); flashMsg(`“${a.name}” was deleted.`); } else setError(friendlyReply(r.data));
  }
  function build(a: Auto | null, recipe?: Recipe) {
    setSaveError(null);
    const tree = a ? graphToTree(a.graph) : recipe ? graphToTree(recipe.graph) : blankTree();
    if (!tree) return;
    setMode({ kind: "build", id: a?.id ?? null, status: a?.status ?? null, value: { name: a?.name ?? recipe?.name ?? "", tree } });
  }
  async function save(id: string | null, v: { name: string; graph: FlowGraph }, turnOn: boolean) {
    setBusy("save"); setSaveError(null);
    const r = id ? await call(`/api/business/${biz}/automations/${id}`, v, "PUT") : await call(`/api/business/${biz}/automations`, v);
    if (!r.ok) { setBusy(null); setSaveError(friendlyReply(r.data)); return; }
    if (turnOn) await call(`/api/business/${biz}/automations/${r.data.id}/enabled`, { enabled: true });
    setBusy(null); setMode({ kind: "hub" }); await load();
    flashMsg(turnOn ? `“${v.name}” is saved and on.` : id ? `“${v.name}” is saved.` : `“${v.name}” is saved as a draft. Turn it on when you are ready.`);
  }
  async function decide(n: Note1, action: "send_sandbox" | "dismiss") {
    setBusy(n.id); setError(null);
    const r = await call(`/api/business/${biz}/notifications/${n.id}/resolve`, { action });
    setBusy(null);
    if (!r.ok) { setError(friendlyReply(r.data)); return; }
    setOpenDraft(null); await load(); tellBell();
    flashMsg(action === "send_sandbox" ? "Marked as sent to the simulated customer (sandbox). Nothing left the app." : "Draft discarded.");
  }
  async function gotIt(n: Note1) {
    setBusy(n.id);
    await call(`/api/business/${biz}/notifications/read`, { ids: [n.id] });
    setBusy(null); await load(); tellBell();
  }

  if (!session || !data) return error ? <ErrorNote>{error}</ErrorNote> : <Loading />;

  if (mode.kind === "build") {
    const cur = data.automations.find((a) => a.id === mode.id);
    return (
      <div className="space-y-6">
        <PageHead title={mode.id ? "Edit automation" : "New automation"} back={{ href: "/room/automations", label: "Automations" }} sub="Change a word in the sentence, and the preview shows what it would do on your books."
          actions={<Btn variant="ghost" onClick={() => setMode({ kind: "hub" })}>Back to automations</Btn>} tabs={false} />
        <AutomationBuilder initial={mode.value} env={env} busy={busy === "save"} error={saveError} status={mode.status}
          onSave={(v, on) => save(mode.id, v, on)} onCancel={() => setMode({ kind: "hub" })} onDelete={cur ? () => setConfirmDelete(cur) : undefined} />
        <DeleteModal item={confirmDelete} busy={busy} onClose={() => setConfirmDelete(null)} onDelete={(a) => void remove(a)} />
      </div>
    );
  }

  const list = data.automations;
  const none = list.length === 0;
  const on = list.filter((a) => a.status === "enabled").length;
  const waitingForYou = isOwner ? notes.filter((n) => (n.kind === "draft_reminder" && !n.resolvedAt) || (n.kind === "plans_prepared" && !n.readAt)) : [];
  const latest = runs?.[0];
  const recipes = none ? data.templates.filter((t) => !FEATURED.includes(t.id)) : data.templates;
  const groups = [...new Set(recipes.map((t) => t.group))];
  const featured = FEATURED.flatMap((id) => data.templates.filter((t) => t.id === id));
  const feed = (runs ?? []).slice(0, 20);
  const days = [...new Set(feed.map((r) => dayLabel(r.startedAt)))];

  return (
    <div className="space-y-6">
      <PageHead title="Automations" sub="Your assistant does the routine part, and you decide the rest."
        actions={isOwner ? <Btn onClick={() => build(null)}><Icon name="plus" size={15} />New automation</Btn> : undefined} />

      <div className="strip rise grid-cols-3" style={{ ["--i" as string]: 1 }}>
        <Metric label="Automations on" value={`${on} of ${list.length}`} sub={none ? "None yet" : on === 0 ? "All off" : "Running after each check"} tone={on > 0 ? "good" : "neutral"} />
        <Metric label="Needs you" value={String(waitingForYou.length)} sub={waitingForYou.length === 0 ? "Nothing waiting" : "Below"} tone={waitingForYou.length > 0 ? "caution" : "neutral"} />
        <Metric label="Last ran" value={latest ? ago(latest.startedAt) : "Not yet"} sub={latest ? latest.automationName : "Nothing has triggered yet"} />
      </div>
      <div className="-mt-2"><Note>Sandbox. Automations tell you, prepare or draft. They never pay, sign, approve or send anything outside the app.</Note></div>

      {flash && <p role="status" className="fade-in rounded-lg bg-good-soft px-3 py-2 text-sm text-good">{flash}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {isOwner && (
        <section id="needs-you" aria-labelledby="needs" className="scroll-mt-24 space-y-3">
          <h2 id="needs" className="display text-xl">Needs you</h2>
          {waitingForYou.length === 0 ? (
            <div className="surface flex items-center gap-3 px-5 py-4"><span className="grid h-8 w-8 place-items-center rounded-full bg-good-soft text-good" aria-hidden><Icon name="check" size={16} /></span><p className="text-sm text-ink-soft">Nothing is waiting for you. When an automation prepares plans or drafts a letter, it shows up here.</p></div>
          ) : (
            <ul className="flat-list">
              {(allNeeds ? waitingForYou : waitingForYou.slice(0, 3)).map((n) => (
                <li key={n.id} className="border-t border-line px-5 py-4 first:border-t-0">
                  <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden><Icon name={n.kind === "draft_reminder" ? "bill" : "plans"} size={16} /></span>
                    <div className="min-w-0 flex-1 basis-72">
                      <p className="text-[15px] font-medium text-ink">{n.title}</p>
                      <p className="mt-0.5 text-sm text-ink-soft">{n.kind === "draft_reminder" ? "A drafted letter. Nothing is sent until you approve it." : "Nothing is signed or sent until you review and sign a plan."} <span className="text-xs">{ago(n.createdAt)}</span></p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {n.kind === "plans_prepared" ? (
                        <>
                          <Btn href="/room/case" size="sm">Review and sign<Icon name="arrow" size={14} /></Btn>
                          <Btn variant="ghost" size="sm" busy={busy === n.id} onClick={() => void gotIt(n)}>Got it</Btn>
                        </>
                      ) : (
                        <>
                          <Btn variant="secondary" size="sm" aria-expanded={openDraft === n.id} onClick={() => setOpenDraft(openDraft === n.id ? null : n.id)}>{openDraft === n.id ? "Hide the letter" : "Preview the letter"}</Btn>
                          <Btn size="sm" busy={busy === n.id} onClick={() => void decide(n, "send_sandbox")}>Approve and send (sandbox)</Btn>
                          <Btn variant="ghost" size="sm" disabled={busy === n.id} onClick={() => void decide(n, "dismiss")}>Discard</Btn>
                        </>
                      )}
                    </div>
                  </div>
                  {openDraft === n.id && (
                    <div className="fade-in mt-3 rounded-xl border border-line bg-panel-quiet p-4 sm:ml-12">
                      <p className="whitespace-pre-line text-sm text-ink">{n.body}</p>
                      <div className="mt-3"><Note>Sandbox. &ldquo;Send&rdquo; marks it as sent to the simulated customer. Nothing leaves the app.</Note></div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {waitingForYou.length > 3 && <Btn variant="ghost" size="sm" onClick={() => setAllNeeds((v) => !v)}>{allNeeds ? "Show fewer" : `Show all ${waitingForYou.length}`}</Btn>}
        </section>
      )}

      {none ? (
        <section aria-labelledby="start" className="space-y-3">
          <div><h2 id="start" className="display text-xl">Start with a recipe</h2><p className="text-sm text-ink-soft">{isOwner ? "Each one opens ready to check against your books. You decide when to turn it on." : "Your owner has not set up any automations yet."}</p></div>
          <RecipeGrid items={featured} isOwner={isOwner} onUse={(r) => build(null, r)} />
          {isOwner && <Btn variant="ghost" onClick={() => build(null)}>Or build your own from scratch</Btn>}
        </section>
      ) : (
        <section aria-labelledby="mine" className="space-y-3">
          <h2 id="mine" className="display text-xl">Your automations</h2>
          <ul className="grid gap-4 xl:grid-cols-2">
            {list.map((a, i) => {
              const isOn = a.status === "enabled";
              return (
                <li key={a.id} className="surface rise flex flex-col p-5" style={{ ["--i" as string]: i + 2 }}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="display text-[17px] leading-snug">{a.name}</p>
                    {isOwner ? (
                      <label className="flex shrink-0 items-center gap-2 text-sm text-ink-soft">
                        <button type="button" role="switch" aria-checked={isOn} aria-label={`${a.name}: ${isOn ? "on" : "off"}`} disabled={busy === a.id} onClick={() => void toggle(a)}
                          className={`press relative h-6 w-11 shrink-0 rounded-full transition-colors ${isOn ? "bg-good" : "bg-line-strong"}`}>
                          <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${isOn ? "translate-x-5" : ""}`} />
                        </button>
                        <span className="w-7 font-medium text-ink" aria-hidden>{isOn ? "On" : "Off"}</span>
                      </label>
                    ) : <Chip tone={isOn ? "good" : "neutral"}>{isOn ? "On" : a.status === "draft" ? "Draft" : "Off"}</Chip>}
                  </div>
                  <p className="mt-2 flex-1 text-[15px] leading-snug text-ink">{flowSentence(a.graph, mm, names)}</p>
                  <p className="mt-3 text-[13px] text-ink-soft">{lastResult(a, runs)}{a.waiting > 0 && <span className="ml-1.5 align-middle"><Chip tone="caution">{a.waiting} waiting</Chip></span>}</p>
                  {isOwner && a.editable && <div className="mt-3"><Btn variant="secondary" size="sm" onClick={() => build(a)}>Edit</Btn></div>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="feed" className="space-y-3">
        <h2 id="feed" className="display text-xl">What happened lately</h2>
        {runs === null ? (
          <div className="surface space-y-3 p-5" aria-busy="true"><Skeleton className="h-4 w-24" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : feed.length === 0 ? (
          <div className="surface px-5 py-6 text-sm text-ink-soft">Nothing has run yet. When an automation finds something in your books, what it found and did is listed here, day by day.</div>
        ) : (
          <div className="surface divide-y divide-line">
            {days.map((d) => (
              <div key={d} className="px-5 py-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{d}</p>
                <ul className="mt-2 space-y-4">
                  {feed.filter((r) => dayLabel(r.startedAt) === d).map((r) => {
                    const s = story(r);
                    const link = runLink(r);
                    return (
                      <li key={r.id} className="flex gap-3">
                        <span className="num mt-0.5 w-11 shrink-0 text-xs text-ink-soft">{clock(r.startedAt)}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm"><span className="font-medium text-ink">{r.automationName}</span>{r.status === "waiting" && <span className="ml-2 align-middle"><Chip tone="caution">Waiting{r.resumeOn ? ` until ${r.resumeOn}` : ""}</Chip></span>}{r.status === "failed" && <span className="ml-2 align-middle"><Chip tone="danger">Did not finish</Chip></span>}</p>
                          {s.found && <p className="mt-0.5 text-[13px] text-ink-soft"><span className="font-medium text-ink">Found:</span> {s.found}</p>}
                          {s.did.map((x, i) => <p key={i} className="mt-0.5 text-[13px] text-ink-soft"><span className="font-medium text-ink">{i === 0 ? "Did:" : "Then:"}</span> {x}</p>)}
                          <p className="mt-1"><DeepLink href={link.href}>{link.label}</DeepLink></p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {recipes.length > 0 && (
        <section aria-labelledby="recipes" className="space-y-4">
          <div><h2 id="recipes" className="display text-xl">{none ? "More recipes" : "Recipes"}</h2><p className="text-sm text-ink-soft">Ready-made automations, grouped by what you want out of them.</p></div>
          {groups.map((g) => (
            <div key={g} className="space-y-2">
              <h3 className="text-sm font-medium text-ink-soft">{g}</h3>
              <RecipeGrid items={recipes.filter((t) => t.group === g)} isOwner={isOwner} onUse={(r) => build(null, r)} />
            </div>
          ))}
        </section>
      )}

      {none && !isOwner && <Empty title="No automations yet">Your owner has not set up any.</Empty>}
      <DeleteModal item={confirmDelete} busy={busy} onClose={() => setConfirmDelete(null)} onDelete={(a) => void remove(a)} />
    </div>
  );
}

function RecipeGrid({ items, isOwner, onUse }: { items: Recipe[]; isOwner: boolean; onUse: (r: Recipe) => void }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((t, i) => (
        <li key={t.id} className="surface lift rise flex flex-col p-5" style={{ ["--i" as string]: i + 2 }}>
          <Chip tone={TAG_TONE[t.tag] ?? "neutral"}>{t.tag}</Chip>
          <p className="display mt-2.5 text-[16px] leading-snug">{t.name}</p>
          <p className="mt-1.5 flex-1 text-sm text-ink-soft">{t.blurb}</p>
          {isOwner && <Btn className="mt-4 self-start" variant="secondary" size="sm" onClick={() => onUse(t)}>Use this<Icon name="arrow" size={14} /></Btn>}
        </li>
      ))}
    </ul>
  );
}

function DeleteModal({ item, busy, onClose, onDelete }: { item: Auto | null; busy: string | null; onClose: () => void; onDelete: (a: Auto) => void }) {
  return (
    <Modal open={!!item} onClose={onClose} title="Delete this automation?">
      <p className="text-sm text-ink-soft">&ldquo;{item?.name}&rdquo; stops running and any run that is waiting is closed. Its past runs stay in your records.</p>
      <div className="mt-4 flex gap-2"><Btn variant="danger" busy={busy === item?.id} onClick={() => item && onDelete(item)}>Delete</Btn><Btn variant="ghost" onClick={onClose}>Keep it</Btn></div>
    </Modal>
  );
}
