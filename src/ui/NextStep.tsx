"use client";
// "What now?" bar: one sentence and one button, derived from the saved state (cash desk + cases). Plain language, no model involved.
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NextStepCard, Skeleton } from "./kit";
import { useAlerts } from "./alerts";
import { call, useSession } from "./session";

interface Step { n: number; text: string; href: string; cta: string }

export function NextStep() {
  const { session } = useSession();
  const path = usePathname();
  const biz = session?.business.id;
  const [step, setStep] = useState<Step | null>(null);
  const { alerts } = useAlerts();

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
      if (session?.user.role === "approver" && waiting.some((w) => w.canConfirm)) s = { n: 4, text: "A signed plan needs your confirmation. Read what it will do, then confirm or decline.", href: "/room/approvals", cta: "Review and confirm" };
      else if (waiting.length > 0 && session?.user.role === "owner") s = { n: 4, text: "Your plan is signed and waiting for a second approver. Nothing is sent until they confirm.", href: "/room/case", cta: "See the plan" };
      else if (r.data.commitments.length === 0 && !open) s = { n: 1, text: "Add a customer order or supplier quote. Your assistant plans around what you confirm.", href: "/room/commitments", cta: "Add an order or quote" };
      else if (open?.status === "running") s = { n: 3, text: "Your assistant is working out your options.", href: caseHref, cta: "Watch it work" };
      else if (last?.lifecycle === "executed") s = { n: 6, text: "Done: the plan ran inside your limits and was checked separately.", href: "/room/safety?tab=limits", cta: "See your limits" };
      else if (last?.lifecycle === "needs_replan") s = { n: 5, text: "Someone said no. Plan again with what they told us, or change the terms.", href: caseHref, cta: "Open the plan" };
      else if (last?.lifecycle === "exhausted") s = { n: 5, text: "No plan fits your limits. See why and decide what to loosen.", href: caseHref, cta: "Open the plan" };
      else if (open) s = { n: 4, text: "Your assistant has options. Compare them and sign one to let it act.", href: caseHref, cta: "Compare and sign" };
      else if (r.data.shortage.shortage) s = { n: 3, text: "Cash will run short. Ask your assistant for ways to fix it.", href: "/room", cta: "See the problem" };
      else s = { n: 2, text: "Cash looks healthy. Add an order or quote to see how plans change.", href: "/room/commitments", cta: "Add an order or quote" };
      setStep(s);
    })();
    return () => { live = false; };
  }, [biz, path, session?.user.role]);

  if (path !== "/room") return null; // shown on Today only: other screens stay quiet
  if (!step) return <div className="surface space-y-3 p-5" aria-hidden><Skeleton className="h-1 w-full" /><Skeleton className="h-5 w-32" /><Skeleton className="h-10 w-full" /></div>;
  if (path === step.href.split("?")[0]) return null;
  // The alerts panel already says "cash will run short" with the figures: it wins, and this bar does not repeat it.
  if (step.n === 3 && step.text.startsWith("Cash will run short") && alerts.some((a) => a.kind === "cash_below_cushion" && a.status === "open")) return null;
  // "Done, the plan ran" would contradict an open alert saying the plan is going off track: the alert wins.
  if (step.n === 6 && alerts.some((a) => a.kind === "strategy_off_track" && a.status === "open")) return null;
  // Where the step sits in the owner's loop: status -> next step -> review and sign -> result.
  const at = (step.n === 6 ? 3 : step.n >= 4 ? 2 : 1) as 0 | 1 | 2 | 3;
  return <NextStepCard at={at} text={step.text} cta={step.cta} href={step.href} />;
}
