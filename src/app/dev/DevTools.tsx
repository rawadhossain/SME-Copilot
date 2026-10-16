"use client";
// Demo tools: start a fresh sample company to walk the story from the beginning, or switch between sample companies. Nothing existing is changed.
import { useState } from "react";
import { Btn, Card, Chip, Field, inputClass } from "@/ui/kit";
import { call, useSession } from "@/ui/session";

export default function DevTools() {
  const { session, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!session) return null;

  async function fresh() {
    setBusy(true); setMsg(null);
    const r = await call("/api/demo/clone", {});
    setBusy(false);
    if (r.ok) {
      try { sessionStorage.setItem("ledgerhand.fresh", String(r.data.name ?? "a new demo run")); } catch { /* optional */ }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload on purpose: it resets all signed-in state
      window.location.assign("/room/commitments"); // a full reload: every screen starts clean on the new sample company
    } else setMsg(r.data?.error ?? "Could not start a fresh demo");
  }
  async function switchTo(id: string) {
    await call("/api/auth/business", { businessId: id });
    await refresh();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload on purpose: it resets all signed-in state
    window.location.assign("/room");
  }

  return (
    <div className="space-y-6">
      <div><h1 className="display text-3xl">Demo tools</h1><p className="text-ink-soft">For walking someone through the product. Not shown to owners in a production deployment.</p></div>
      <Card title="Start from the beginning" subtitle="Creates a new sample company with the same books and no orders, so the story can be walked again. Nothing existing is changed or erased.">
        <Btn busy={busy} onClick={fresh}>Start a fresh demo</Btn>
        {msg && <p role="alert" className="mt-3 text-sm text-danger">{msg}</p>}
      </Card>
      <Card title="Sample companies" subtitle="Switch the whole app to another sample company.">
        <div className="max-w-md"><Field label="Company">
          <select className={inputClass} value={session.business.id} onChange={(e) => void switchTo(e.target.value)}>
            {session.businesses.map((b) => <option key={b.id} value={b.id}>{b.isTest ? "Demo copy: " : ""}{b.name.replace(" (SYNTHETIC)", "")}</option>)}
          </select>
        </Field></div>
        <p className="mt-3 text-sm text-ink-soft">Working in: <Chip tone={session.business.isTest ? "accent" : "neutral"}>{session.business.isTest ? "demo copy" : "original sample company"}</Chip></p>
      </Card>
    </div>
  );
}
