// The human-readable evidence summary: one standalone HTML file (inline CSS and script, no external resources). It embeds the full bundle and
// re-verifies it in the browser with the same verifier as scripts/verify-export.mjs. Print it to PDF from the browser if a PDF is needed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { verifierSource } from "./build";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (minor: string | null | undefined, cur: string) => {
  if (minor === null || minor === undefined) return "–";
  const v = BigInt(minor), neg = v < 0n, a = neg ? -v : v;
  return `${neg ? "−" : ""}${cur === "GBP" ? "£" : cur + " "}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(a % 100n).toString().padStart(2, "0")}`;
};
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}%`;
const lever = (l: any) => ({
  supplier_reduce_deposit: `Supplier deposit cut to ${pct(l.percentBps)}`, supplier_defer_balance: `Supplier balance paid ${l.daysAfterShipment} days after shipment`, buyer_request_deposit: `Buyer deposit ${pct(l.percentBps)}`,
  finance_invoice: `Invoice finance, ${pct(l.advanceBps)} advance`, chase_overdue: `Chase overdue invoices: pay within ${l.payWithinDays} days`, early_payment_discount: `Early-payment discount ${pct(l.discountBps)} for ${l.daysEarly} days early`,
} as Record<string, string>)[l.kind] ?? l.kind;

export function renderEvidenceHtml(b: any): string {
  const cur = b.business.currency;
  const names = (id: string) => id;
  void names;
  const runs: any[] = b.runs;
  const sections: string[] = [];
  sections.push(`<section><h2>The case</h2><p>${esc(b.business.name)}. Started by a <b>${esc(runs[0]?.trigger?.type)}</b>${runs[0]?.trigger?.reason ? `: lowest balance ${money(runs[0].trigger.reason.minBalanceMinor, cur)} in week ${runs[0].trigger.reason.minBalanceWeek}` : ""}. ${runs.length} planning round${runs.length === 1 ? "" : "s"}.</p>
    <table><tr><th>Round</th><th>Planner</th><th>Status</th><th>Plans</th><th>Learned constraints</th></tr>${runs.map((r) => `<tr><td>${r.round}</td><td>${esc(r.planSource)}${r.fallbackUsed ? " (fallback)" : ""} · ${esc(r.model)}</td><td>${esc(r.lifecycle)}</td><td>${r.plans.length}</td><td>${r.constraints.length ? esc(JSON.stringify(r.constraints.map((c: any) => ({ kind: c.kind, excluded: c.excluded, maxPercentBps: c.maxPercentBps, minPercentBps: c.minPercentBps, minDays: c.minDays, minDiscountBps: c.minDiscountBps })))) : "none"}</td></tr>`).join("")}</table></section>`);
  sections.push(`<section><h2>Plans considered</h2>${runs.map((r) => `<h3>Round ${r.round}${r.doNothing ? ` · do nothing: lowest ${money(r.doNothing.minBalanceMinor, cur)}` : ""}</h3><table><tr><th>#</th><th>Levers</th><th>Lowest balance</th><th>Cost</th><th>Closing</th></tr>${r.plans.map((p: any, i: number) => `<tr><td>${i + 1}</td><td>${p.plan.levers.map((l: any) => esc(lever(l))).join("<br>")}</td><td class="n">${money(p.plan.metrics.minBalanceMinor, cur)}</td><td class="n">${money(p.plan.metrics.totalCostMinor, cur)}</td><td class="n">${money(p.plan.metrics.closingAtHorizonMinor, cur)}</td></tr>`).join("")}</table>`).join("")}</section>`);
  sections.push(`<section><h2>Signed authorisations and the mandate</h2>${b.mandates.map((m: any) => `<p>Mandate version <b>${m.version}</b>${m.active ? " (active)" : ""}, signature <code>${esc(m.signature.slice(0, 24))}…</code></p>`).join("")}
    <table><tr><th>Authorisation</th><th>Status</th><th>Signed by</th><th>Expires</th><th>Mandate</th><th>Signature</th></tr>${b.authorisations.map((a: any) => `<tr><td><code>${esc(a.id.slice(0, 8))}</code> plan <code>${esc(a.planId.slice(0, 8))}</code></td><td>${esc(a.status)}</td><td>${esc(a.approvedBy ?? "–")}</td><td>${esc(a.expiresAt)}</td><td>v${a.mandateVersion}</td><td><code>${esc((a.signature ?? "none").slice(0, 24))}…</code></td></tr>`).join("")}</table></section>`);
  sections.push(`<section><h2>Every action and its gate result</h2>${b.authorisations.map((a: any) => `<h3>Authorisation ${esc(a.id.slice(0, 8))}</h3><table><tr><th>Action</th><th>Gate</th><th>Status</th></tr>${a.actions.map((x: any) => `<tr><td>${esc(x.kind)}</td><td>${esc(x.gateResult?.decision)}${x.gateResult?.reasons?.length ? `: ${esc(x.gateResult.reasons[0])}` : ""}</td><td>${esc(x.status)}</td></tr>`).join("")}</table>`).join("")}</section>`);
  sections.push(`<section><h2>Verification</h2>${b.authorisations.filter((a: any) => a.execution?.verification).map((a: any) => { const v = a.execution.verification; return `<h3>Authorisation ${esc(a.id.slice(0, 8))}: <span class="${v.ok ? "ok" : "bad"}">${v.ok ? "passed" : "FAILED"}</span></h3><table><tr><th>Measure</th><th>Plan promised</th><th>Agreed terms give</th><th>Recomputed from the sandbox</th></tr>${v.metrics.map((m: any, i: number) => { const f = (x: string | null) => (m.kind === "money" ? money(x, cur) : x === null ? "none" : "week " + x); const p = v.promiseVsAgreed?.metrics?.[i]; return `<tr><td>${esc(m.name)}</td><td class="n">${p ? f(p.promised) : "–"}</td><td class="n">${f(m.promised)}</td><td class="n">${f(m.actual)}</td></tr>`; }).join("")}</table><p>${esc(v.promiseVsAgreed?.label ?? "")}</p>`; }).join("") || "<p>Nothing was executed.</p>"}</section>`);
  const s = b.scoreboard;
  sections.push(`<section><h2>Do nothing against the executed plan</h2>${s ? `<table><tr><th></th><th>Do nothing</th><th>Executed</th></tr><tr><td>Lowest balance</td><td class="n">${money(s.doNothing?.minBalanceMinor, cur)}</td><td class="n">${s.executedPlan ? money(s.executedPlan.minBalanceMinor, cur) : "–"}</td></tr><tr><td>Weeks below zero</td><td class="n">${s.doNothing?.weeksBelowZero ?? "–"}</td><td class="n">${s.executedPlan?.weeksBelowZero ?? "–"}</td></tr><tr><td>Total cost</td><td class="n">${money("0", cur)}</td><td class="n">${s.executedPlan ? money(s.executedPlan.totalCostMinor, cur) : "–"}</td></tr></table><p>Owner approvals: ${s.ownerApprovals} · denied or blocked actions: ${s.deniedOrBlocked}. ${esc(s.label)}</p>` : "<p>No scoreboard entry.</p>"}</section>`);
  sections.push(`<section><h2>The log and its chain</h2><p>${b.log.count} records. Head hash <code>${esc(b.log.head?.hash)}</code>. Keep this value: a later export with fewer records or a different head shows that something was removed or changed.</p><p>Suspicious-text records in the log: ${b.log.suspiciousTextRecords}.</p></section>`);

  const css = `body{font:15px/1.5 system-ui,sans-serif;max-width:980px;margin:2rem auto;padding:0 1rem;color:#16201e;background:#f4f1e8}h1{font-size:1.8rem;letter-spacing:-.02em}section{background:#fcfbf7;border:1px solid #ddd7c8;border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-top:1px solid #ddd7c8;padding:.35rem .5rem;text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}code{font-size:.8rem}.ok{color:#1b7a4a;font-weight:600}.bad{color:#b0261d;font-weight:600}#verify li{margin:.2rem 0}@media print{body{background:#fff}}`;
  const data = JSON.stringify(b).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evidence · ${esc(b.business.name)}</title><style>${css}</style></head><body>
<h1>Evidence export</h1><p><b>${esc(b.business.name)}</b> · exported ${esc(b.exportedAt)} · SYNTHETIC data · no keys, passwords or raw documents inside.</p>
<section><h2>Re-verified in this page</h2><p>This file checks itself from its own contents: the owner signatures, the hashes they bind, and the hash chain of the log. Nothing is fetched.</p><p id="verdict">Verifying…</p><ul id="verify"></ul></section>
${sections.join("\n")}
<script type="application/json" id="bundle">${data}</script>
<script type="module">
${verifierSource()}
const bundle = JSON.parse(document.getElementById("bundle").textContent);
const out = document.getElementById("verify"), verdict = document.getElementById("verdict");
try {
  const checks = await verifyBundle(bundle);
  for (const c of checks) { const li = document.createElement("li"); li.className = c.ok ? "ok" : "bad"; li.textContent = (c.ok ? "✓ " : "✗ ") + c.name + " — " + c.detail; out.appendChild(li); }
  const bad = checks.filter((c) => !c.ok).length;
  verdict.className = bad ? "bad" : "ok";
  verdict.textContent = bad ? bad + " check(s) FAILED: do not trust this file." : "All " + checks.length + " checks passed.";
} catch (e) { verdict.className = "bad"; verdict.textContent = "This browser cannot run the check (Ed25519 in Web Crypto is needed). Use scripts/verify-export.mjs. " + e; }
</script></body></html>`;
}
