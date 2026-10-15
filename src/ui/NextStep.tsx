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
    if (!biz) return;
    let live = true;
    void (async () => {
      const [r, c] = await Promise.all([call(`/api/business/${biz}/room`), call(`/api/business/${biz}/cases`)]);
      if (!live || !r.ok || !c.ok) return;
      const roots: { runId: string; lifecycle: string; parentRunId: string | null; status: string }[] = c.data.filter((x: { parentRunId: string | null }) => !x.parentRunId);
      const open = roots.filter((x) => x.lifecycle !== "superseded").at(-1);
      const last = [...c.data].at(-1) as { lifecycle: string } | undefined;
      const caseHref = open ? `/room/case?run=${open.runId}` : "/room/case";
      let s: Step;
      if (r.data.commitments.length === 0 && !open) s = { n: 1, text: "Start here: give the agent something to plan around. Add the two sample documents (a customer order and a supplier quote).", href: "/room/commitments", cta: "Add the documents" };
      else if (open?.status === "running") s = { n: 3, text: "The agent is working out your options. This takes a moment.", href: caseHref, cta: "Watch it work" };
      else if (last?.lifecycle === "executed") s = { n: 6, text: "Done. The plan ran inside your limits and was checked independently. Look at the proof, or break the limits to see them hold.", href: "/room/mandate", cta: "Try to break the limits" };
      else if (last?.lifecycle === "needs_replan") s = { n: 5, text: "A supplier or customer said no to something. Tell the agent to try again with that new information.", href: caseHref, cta: "Open the decision" };
      else if (last?.lifecycle === "exhausted") s = { n: 5, text: "No plan fits inside your limits. Read why and decide what to loosen.", href: caseHref, cta: "Open the decision" };
      else if (open) s = { n: 4, text: "The agent has options for you. Compare them, then sign the one you like: that is what lets it act.", href: caseHref, cta: "Compare and sign" };
      else if (r.data.shortage.shortage) s = { n: 3, text: "Cash will run short. Ask the agent for ways to fix it.", href: "/room", cta: "See the problem" };
      else s = { n: 2, text: "Your cash looks healthy. Add a new order or quote to see how the agent reacts.", href: "/room/commitments", cta: "Add a document" };
      setStep(s);
    })();
    return () => { live = false; };
  }, [biz, path]);

  if (!step || path === step.href.split("?")[0]) return null;
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/30 bg-accent-soft/50 px-4 py-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-white" aria-hidden>{step.n}</span>
      <p className="min-w-0 flex-1 text-sm"><b className="text-accent">Your next step. </b>{step.text}</p>
      <Btn href={step.href}>{step.cta}</Btn>
    </div>
  );
}
