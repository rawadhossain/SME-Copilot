"use client";
// "What now?" bar: one sentence and one button, derived from the saved state (cash desk + cases). Plain language, no model involved.
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Btn } from "./kit";
import { call, useSession } from "./session";

interface Step { n: number; text: string; href: string; cta: string }

export function NextStep() {
  const { session } = useSession();
  const path = usePathname();
  const biz = session?.business.id;
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    if (!biz || path !== "/room") return;
    let live = true;
    void (async () => {
      const [r, c, ap] = await Promise.all([call(`/api/business/${biz}/room`), call(`/api/business/${biz}/cases`), call(`/api/business/${biz}/approvals`)]);
      if (!live || !r.ok || !c.ok) return;
      const waiting: { canConfirm: boolean }[] = ap.ok ? ap.data : [];
      const roots: { runId: string; lifecycle: string; parentRunId: string | null; status: string }[] = c.data.filter((x: { parentRunId: string | null }) => !x.parentRunId);
      const open = roots.filter((x) => x.lifecycle !== "superseded").at(-1);
      const last = [...c.data].at(-1) as { lifecycle: string } | undefined;
      const caseHref = open ? `/room/case?run=${open.runId}` : "/room/case";
      let s: Step;
      if (session?.user.role === "approver" && waiting.some((w) => w.canConfirm)) s = { n: 4, text: "A plan the owner signed is waiting for your confirmation. Read what it will do, then confirm or decline it with your own password.", href: "/room/approvals", cta: "Review and confirm" };
      else if (waiting.length > 0 && session?.user.role === "owner") s = { n: 4, text: "Your plan is signed and waiting for a second approver. Nothing is sent until a different approver confirms it.", href: "/room/case", cta: "See the plan" };
      else if (r.data.commitments.length === 0 && !open) s = { n: 1, text: "Start here: add a customer order or a supplier quote. Your assistant plans around what you confirm.", href: "/room/commitments", cta: "Add an order or quote" };
      else if (open?.status === "running") s = { n: 3, text: "Your assistant is working out your options. This takes a moment.", href: caseHref, cta: "Watch it work" };
      else if (last?.lifecycle === "executed") s = { n: 6, text: "Done. The plan ran inside your limits and was checked separately. Look at the records, or try to break your limits to see them hold.", href: "/room/safety?tab=limits", cta: "See your limits" };
      else if (last?.lifecycle === "needs_replan") s = { n: 5, text: "A supplier or customer said no to something. Plan again with what they told us, or change the terms yourself.", href: caseHref, cta: "Open the plan" };
      else if (last?.lifecycle === "exhausted") s = { n: 5, text: "No plan fits inside your limits. Read why and decide what to loosen.", href: caseHref, cta: "Open the plan" };
      else if (open) s = { n: 4, text: "Your assistant has options for you. Compare them, then sign the one you like: that is what lets it act.", href: caseHref, cta: "Compare and sign" };
      else if (r.data.shortage.shortage) s = { n: 3, text: "Cash will run short. Ask your assistant for ways to fix it.", href: "/room", cta: "See the problem" };
      else s = { n: 2, text: "Your cash looks healthy. Add a new order or quote to see how your plans change.", href: "/room/commitments", cta: "Add an order or quote" };
      setStep(s);
    })();
    return () => { live = false; };
  }, [biz, path, session?.user.role]);

  if (!step || path !== "/room" || path === step.href.split("?")[0]) return null; // shown on Today only: other screens stay quiet
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/30 bg-accent-soft/50 px-4 py-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-white" aria-hidden>{step.n}</span>
      <p className="min-w-0 flex-1 text-sm"><b className="text-accent">Your next step. </b>{step.text}</p>
      <Btn href={step.href}>{step.cta}</Btn>
    </div>
  );
}
