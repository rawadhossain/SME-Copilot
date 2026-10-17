/* eslint-disable @typescript-eslint/no-explicit-any */
// End-to-end smoke (not a test suite): starts the app on its own port and drives the MAIN STORY through the REAL routes with a cookie
// jar: sign-in (with the security checks), a fresh demo clone, documents, shortage, plans, preview, step-up signing with a second
// approver, execute (the buyer caps the deposit), re-plan, sign again, execute, verify, scoreboard, evidence chain.
//   bun run e2e:smoke                 offline: mock provider, no key, no network (the scripted planner)
//   REPLAY=1 bun run e2e:smoke        the CANONICAL recordings (fixtures/llm-recordings-live), empty key, no network: must plan with source ai
//   RECORD=1 bun run e2e:smoke        records/refreshes the canonical set with the real model (LLM_REUSE=1: only missing requests are live)
// It stops only the server process it started, by PID.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSignaturePng } from "./png-fixture";

const RECORD = process.env.RECORD === "1";
const REPLAY = process.env.REPLAY === "1";
const CANON = RECORD || REPLAY; // the canonical set: documents and plans go through the real server and the recordings
const PORT = Number(process.env.SMOKE_PORT ?? 3111);
const BASE = `http://localhost:${PORT}`;
const OWNER = { email: "owner@mercer-vale.example", password: "Ledger-Owner-2026" };
const APPROVER = { email: "finance@mercer-vale.example", password: "Ledger-Approver-2026" };

let server: ChildProcess | null = null;
let serverOut = "";
let cookie = "";
let csrf = "";
const log = (s: string) => console.log(`  ${s}`);

async function api(path: string, init: { method?: string; body?: unknown; csrf?: boolean; cookie?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE };
  if (init.cookie !== false && cookie) headers.cookie = cookie;
  if (init.csrf !== false && csrf) headers["x-csrf-token"] = csrf;
  const res = await fetch(`${BASE}${path}`, { method: init.method ?? (init.body ? "POST" : "GET"), headers, body: init.body ? JSON.stringify(init.body) : undefined, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set && set.startsWith("sme_session=")) cookie = set.split(";")[0];
  const json = await res.json().catch(() => null);
  return { status: res.status, json: json as Record<string, any> };
}

async function startServer() {
  const env = { ...process.env, PORT: String(PORT) } as NodeJS.ProcessEnv;
  if (RECORD) {
    env.LLM_MODE = "record"; env.LLM_REUSE = "1"; env.LLM_RECORDINGS_DIR = "fixtures/llm-recordings-live"; env.AGENT_MAX_STEPS = process.env.AGENT_MAX_STEPS ?? "4";
  } else if (REPLAY) {
    env.LLM_PROVIDER = "openai-compatible"; env.LLM_MODE = "replay"; env.LLM_API_KEY = ""; env.LLM_RECORDINGS_DIR = "fixtures/llm-recordings-live";
    env.LLM_MODEL = env.LLM_MODEL || "gpt-4o-mini"; env.LLM_BASE_URL = env.LLM_BASE_URL || "https://api.openai.com/v1";
  } else {
    env.LLM_PROVIDER = "mock"; env.LLM_MODE = "live"; env.LLM_API_KEY = ""; delete env.LLM_RECORDINGS_DIR;
  }
  env.SHORTAGE_AUTO_PLAN = "on";
  const child = spawn(process.execPath.includes("bun") ? "node" : process.execPath, [join("node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT)], { env, stdio: "pipe" });
  server = child;
  let out = "";
  child.stdout?.on("data", (d) => { out += d; serverOut += d; });
  child.stderr?.on("data", (d) => { out += d; serverOut += d; });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await fetch(`${BASE}/login`, { redirect: "manual" }); if (r.status < 500) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${out.slice(-400)}`);
  }
  throw new Error(`server did not start: ${out.slice(-400)}`);
}

function stopServer() {
  if (!server?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
  else server.kill();
}

async function main() {
  await startServer();
  try {
    // ---------- 1. sign-in and its security ----------
    assert.equal((await api("/api/business/00000000-0000-4000-8000-000000000000/room", { cookie: false })).status, 401, "no session: refused");
    const page = await fetch(`${BASE}/room`, { redirect: "manual" });
    assert.ok([302, 303, 307, 308].includes(page.status), "no session: pages redirect to /login");
    const wrong = await api("/api/auth/login", { body: { email: OWNER.email, password: "wrong" }, csrf: false, cookie: false });
    assert.equal(wrong.status, 401);
    const login = await api("/api/auth/login", { body: OWNER, csrf: false, cookie: false });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    assert.ok(cookie.startsWith("sme_session="));
    csrf = login.json.csrfToken;
    assert.equal((await api("/api/demo/clone", { method: "POST", body: {}, csrf: false })).status, 403, "a change without the CSRF token is refused");
    const ghost = `nobody-${Date.now()}@example.test`;
    const rawLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(OWNER) });
    const flags = rawLogin.headers.get("set-cookie") ?? "";
    assert.ok(/HttpOnly/i.test(flags) && /SameSite=Strict/i.test(flags) && /Path=\//i.test(flags) && /Max-Age=\d+/i.test(flags), `session cookie flags: ${flags.replace(/=[^;]+/, "=<token>")}`);
    const burst = [];
    for (let i = 0; i < 6; i++) burst.push((await api("/api/auth/login", { body: { email: ghost, password: "x" }, csrf: false, cookie: false })).status);
    assert.deepEqual([burst.slice(0, 5).every((s) => s === 401), burst[5]], [true, 429], "the sixth failed sign-in is rate limited");
    log("sign-in: wrong password 401, no session 401/redirect, missing CSRF 403, sixth failure 429");

    // ---------- 2. a fresh demo clone ----------
    const clone = await api("/api/demo/clone", { method: "POST", body: {} });
    assert.equal(clone.status, 200, JSON.stringify(clone.json));
    const biz = clone.json.id as string;
    log(`fresh demo clone: ${clone.json.name}`);
    const other = await api("/api/business/50d04f73-3186-40b1-96fe-46f478ea6134/room");
    assert.equal(other.status, 403, "a session cannot read another business");

    // ---------- 3. documents -> confirm -> shortage ----------
    let shortageRunId: string | null = null;
    const samples = (await api("/api/demo/samples")).json.samples as { filename: string; kind: string; text: string }[];
    const ups: string[] = [];
    for (const smp of samples) {
      const up = await api(`/api/business/${biz}/documents`, { body: { filename: smp.filename, kind: smp.kind, text: smp.text } });
      assert.equal(up.status, 200, JSON.stringify(up.json));
      assert.equal(up.json.extraction.status, "pending_confirmation", `${smp.filename} was read cleanly`);
      ups.push(up.json.extraction.id);
    }
    for (const id of ups) {
      const c = await api(`/api/extractions/${id}/confirm`, { body: { confirmedBy: "Alex Mercer (owner)" } });
      assert.equal(c.status, 200, JSON.stringify(c.json));
      if (c.json.shortage?.runId) shortageRunId = c.json.shortage.runId;
      log(`document confirmed; shortage check: ${c.json.shortage?.status}`);
    }
    assert.ok(shortageRunId, "confirming the commitments flagged a shortage and started a planning run");
    const room = (await api(`/api/business/${biz}/room`)).json;
    assert.equal(room.shortage.shortage, true);
    log(`shortage: ${room.shortage.reason.kind}, lowest ${room.shortage.reason.minBalanceMinor} minor units in week ${room.shortage.reason.minBalanceWeek}`);

    // ---------- 4. plans -> preview -> sign (step-up) -> execute ----------
    // Round 0 of the canonical story signs a plan that asks the buyer for a deposit (the buyer caps it, which drives the re-plan);
    // later rounds prefer a plan with a chase or early-payment lever.
    const BOOKS = ["chase_overdue", "early_payment_discount"];
    const pick = (c: any, runId: string, first: boolean) => {
      const run = c.runs.find((r: any) => r.id === runId);
      const sets = run.plans.map((p: any) => p.plan);
      const has = (p: any, kinds: string[]) => p.levers.some((l: any) => kinds.includes(l.kind));
      const nameById = Object.fromEntries((c.counterparties as any[]).map((x) => [x.id, x.name as string]));
      // The stingy buyer (Northgate) caps deposits at 10% and wants 1.5% to pay 15 days early: either refusal drives the re-plan.
      const stingy = (p: any) => p.levers.some((l: any) => ["buyer_request_deposit", "early_payment_discount"].includes(l.kind) && String(nameById[l.counterpartyId]).includes("Northgate"));
      if (first && CANON) return sets.find((p: any) => stingy(p)) ?? sets.find((p: any) => has(p, ["buyer_request_deposit"]) && has(p, BOOKS)) ?? sets.find((p: any) => has(p, ["buyer_request_deposit"])) ?? sets[0];
      return sets.find((p: any) => has(p, BOOKS)) ?? sets[0];
    };
    // Run something as the APPROVER: their own sign-in and their own cookie jar. The owner's session is put back afterwards.
    const asApprover = async <T,>(fn: () => Promise<T>): Promise<T> => {
      const keep = { cookie, csrf };
      cookie = ""; csrf = "";
      try {
        const lg = await api("/api/auth/login", { body: APPROVER, csrf: false, cookie: false });
        assert.equal(lg.status, 200, JSON.stringify(lg.json));
        csrf = lg.json.csrfToken;
        assert.equal((await api("/api/auth/business", { body: { businessId: biz } })).status, 200, "the approver works in the same company");
        return await fn();
      } finally { cookie = keep.cookie; csrf = keep.csrf; }
    };
    const sign = async (runId: string, plan: any) => {
      const body = { runId, planId: plan.id, confirmations: 2 };
      const prev = await api(`/api/business/${biz}/plan-authorisations/preview`, { body });
      assert.equal(prev.status, 200, JSON.stringify(prev.json));
      assert.ok(prev.json.summary.asks.length > 0 && prev.json.mandateVersion);
      assert.ok(Object.keys(prev.json.letters).length > 0 && Object.values<any>(prev.json.letters).every((l) => /^Dear /.test(l.paragraphs[0])), "a professional first draft letter exists for each counterparty");
      // Signing needs the letters AND a drawn signature as well as the password.
      const noSig = await api(`/api/business/${biz}/plan-authorisations`, { body: { ...body, letters: prev.json.letters, password: OWNER.password } });
      assert.equal(noSig.status, 400, "no drawn signature, no signing");
      const noLetters = await api(`/api/business/${biz}/plan-authorisations`, { body: { ...body, signatureImage: makeSignaturePng(), password: OWNER.password } });
      assert.equal(noLetters.status, 400, "no letters, no signing");
      const signed = { letters: prev.json.letters, signatureImage: makeSignaturePng() };
      const noPw = await api(`/api/business/${biz}/plan-authorisations`, { body: { ...body, ...signed, password: "wrong" } });
      assert.equal(noPw.status, 403, "a wrong step-up password signs nothing");
      // An approver account cannot sign a plan: only the owner does.
      await asApprover(async () => {
        const asAppr = await api(`/api/business/${biz}/plan-authorisations`, { body: { ...body, ...signed, password: APPROVER.password } });
        assert.equal(asAppr.status, 403, "an approver cannot sign a plan as the owner");
      });

      // The owner confirms with their OWN password only. The plan then WAITS; the system has not signed it and nothing can run.
      const ok = await api(`/api/business/${biz}/plan-authorisations`, { body: { ...body, ...signed, password: OWNER.password } });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.status, "awaiting_second", "a plan that needs a second approver waits for one");
      const id = ok.json.authorisationId as string;
      const early = await api(`/api/plan-authorisations/${id}/execute`, { method: "POST", body: {} });
      assert.ok(early.status >= 400 && early.json?.status !== "completed", `nothing runs before the second approval (HTTP ${early.status})`);
      // The owner cannot be their own second approver, and the owner's screen shows it cannot be confirmed by them.
      const self = await api(`/api/plan-authorisations/${id}/second-approval`, { body: { password: OWNER.password } });
      assert.ok([403, 422].includes(self.status), `the owner cannot give the second approval (HTTP ${self.status})`);
      const mine = (await api(`/api/business/${biz}/approvals`)).json as any[];
      assert.ok(mine.some((x) => x.id === id && x.canConfirm === false && x.summary.asks.length > 0), "the owner sees the waiting plan but cannot confirm it");

      // The approver, signed in as THEMSELVES, reads it and confirms with their own password.
      await asApprover(async () => {
        const theirs = (await api(`/api/business/${biz}/approvals`)).json as any[];
        assert.ok(theirs.some((x) => x.id === id && x.canConfirm === true), "the approver sees the plan waiting for them");
        const wrong = await api(`/api/plan-authorisations/${id}/second-approval`, { body: { password: "wrong" } });
        assert.equal(wrong.status, 403, "a wrong approver password confirms nothing");
        const good = await api(`/api/plan-authorisations/${id}/second-approval`, { body: { password: APPROVER.password } });
        assert.equal(good.status, 200, JSON.stringify(good.json));
        assert.equal(good.json.status, "authorised");
        const again = await api(`/api/plan-authorisations/${id}/second-approval`, { body: { password: APPROVER.password } });
        assert.equal(again.status, 409, "it can only be confirmed once");
      });
      return id;
    };
    let c1 = (await api(`/api/business/${biz}/cases/${shortageRunId}`)).json;
    const plan1 = pick(c1, shortageRunId!, true);
    log(`plans: ${c1.runs[0].plans.length}, source ${c1.runs[0].planSource}${c1.runs[0].fallbackUsed ? " (fallback used)" : ""}; signing [${plan1.levers.map((l: any) => l.kind).join(", ")}]`);
    const auth1 = await sign(shortageRunId!, plan1);
    const ex1 = await api(`/api/plan-authorisations/${auth1}/execute`, { method: "POST", body: {} });
    log(`attempt 1: ${ex1.json.status}`);
    let finalAuth = auth1;
    let ex = ex1;
    if (ex1.json.status === "needs_replan") {
      log(`learned: ${JSON.stringify(ex1.json.outcome.constraints.map((k: any) => ({ kind: k.kind, maxPercentBps: k.maxPercentBps, minDays: k.minDays, minDiscountBps: k.minDiscountBps, excluded: k.excluded })))}`);
      const rp = await api(`/api/plan-authorisations/${auth1}/replan`, { method: "POST", body: {} });
      assert.equal(rp.status, 200, JSON.stringify(rp.json));
      assert.equal(rp.json.status, "replanned");
      c1 = (await api(`/api/business/${biz}/cases/${shortageRunId}`)).json;
      const plan2 = pick(c1, rp.json.newRunId, false);
      log(`re-plan (round ${rp.json.round}): ${rp.json.plans.length} plans; signing [${plan2.levers.map((l: any) => l.kind).join(", ")}]`);
      finalAuth = await sign(rp.json.newRunId, plan2);
      ex = await api(`/api/plan-authorisations/${finalAuth}/execute`, { method: "POST", body: {} });
      log(`attempt 2: ${ex.json.status}`);
    }
    assert.equal(ex.json.status, "completed", JSON.stringify(ex.json.verification?.explanation ?? ex.json.outcome?.failure));
    assert.equal(ex.json.verification.ok, true);

    if (CANON) {
      const cnow = (await api(`/api/business/${biz}/cases/${shortageRunId}`)).json;
      const sources = (cnow.runs as any[]).map((r) => `${r.planSource}${r.fallbackUsed ? "+fallback" : ""}`);
      log(`planner sources per round: ${sources.join(", ")}`);
      assert.ok((cnow.runs as any[]).every((r) => r.planSource === "ai" && !r.fallbackUsed), `the model produced valid plans in every round (${sources.join(", ")})`);
      const lastAuth = (cnow.authorisations as any[]).find((a) => a.authorisation.id === finalAuth);
      const kinds = lastAuth.authorisation.terms.entries.map((e: any) => e.lever.kind);
      assert.ok(kinds.some((k: string) => ["chase_overdue", "early_payment_discount"].includes(k)), `the executed plan includes a chase or early-payment lever (${kinds.join(", ")})`);
      log(`executed plan levers: ${kinds.join(", ")}`);
    }
    // ---------- 5. status, scoreboard, evidence ----------
    const st = (await api(`/api/plan-authorisations/${finalAuth}`)).json;
    assert.equal(st.run.lifecycle, "executed");
    const sb = (await api(`/api/business/${biz}/scoreboard`)).json;
    assert.equal(sb.summary.verified, 1);
    log(`scoreboard: ${JSON.stringify(sb.summary)}; ${sb.entries[0].label}`);
    const ev = (await api(`/api/business/${biz}/evidence`)).json;
    assert.equal(ev.chain.ok, true);
    const events = (ev.records as { event: string }[]).map((r) => r.event);
    for (const needed of ["auth.step_up", "auth.second_approval", "plan.authorised", "plan.verified"]) assert.ok(events.includes(needed), `evidence has ${needed}`);
    assert.ok(events.includes("auth.step_up_failed"), "the failed step-up is in the log");
    log(`evidence: ${ev.count} records, chain ok; sign-in, step-up, second approval and signing are in the log`);
    // Funding options (Phase K): happy path against a hand figure, and the refusals.
    {
      const offer = { id: "Loan A", lender: "Test lender", product: "term_loan", principal: "20000.00", upfrontFees: "1000.00", disbursementDate: "2026-10-20", schedule: { kind: "equal", firstDate: "2026-10-27", count: 8, frequency: "weekly", amount: "2750.00" } };
      const ok = await api(`/api/business/${biz}/funding/compare`, { body: { offers: [offer] } });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.comparison.offers[0].cost.totalCostMinor, "300000", "20,000 advanced, 1,000 fees, 8 x 2,750 repaid = 3,000.00 cost");
      assert.ok(ok.json.comparison.doNotBorrow.weekly.length >= 13, "the not-borrowing line is returned for the chart");
      assert.equal((await api(`/api/business/${biz}/funding/compare`, { body: { offers: [offer] }, cookie: false, csrf: false })).status, 401, "needs a session");
      assert.equal((await api(`/api/business/${biz}/funding/compare`, { body: { offers: [offer] }, csrf: false })).status, 403, "needs the CSRF token");
      const badAmount = await api(`/api/business/${biz}/funding/compare`, { body: { offers: [{ ...offer, principal: "20000.123" }] } });
      assert.equal(badAmount.status, 400, "a three-decimal GBP amount is refused, not rounded");
      const under = await api(`/api/business/${biz}/funding/compare`, { body: { offers: [{ ...offer, schedule: { ...offer.schedule, amount: "1000.00" } }] } });
      assert.equal(under.status, 400, "an offer that repays less than it advances is refused");
      // "Ask about my cash" is read-only and needs a session and the CSRF token; a request to act is declined and creates nothing.
      assert.equal((await api(`/api/business/${biz}/ask`, { body: { question: "Why am I short?" }, cookie: false, csrf: false })).status, 401, "ask needs a session");
      assert.equal((await api(`/api/business/${biz}/ask`, { body: { question: "Why am I short?" }, csrf: false })).status, 403, "ask needs the CSRF token");
      assert.equal((await api(`/api/business/${biz}/ask`, { body: { question: "" } })).status, 400, "an empty question is refused");
      const authsBefore = (await api(`/api/business/${biz}/cases`)).json.length;
      const asked = await api(`/api/business/${biz}/ask`, { body: { question: "sign it for me" } });
      assert.ok(asked.status === 200 && asked.json.ok && /cannot sign/i.test(asked.json.answer), "a request to act is declined");
      assert.equal((await api(`/api/business/${biz}/cases`)).json.length, authsBefore, "asking opened no case");
      log("ask about my cash: needs a session and CSRF, empty refused, 'sign it for me' declined with nothing created");
      log("funding: comparison matches the hand figure; no session, no CSRF token, a too-precise amount and an under-repaying offer are all refused");

      // Saved offers: save, read back, replace (the set is replaced, the old rows archived), and a bad save writes nothing.
      const put = await api(`/api/business/${biz}/funding/offers`, { method: "PUT", body: { offers: [offer] } });
      assert.equal(put.status, 200, JSON.stringify(put.json));
      assert.equal(put.json.saved, 1);
      const bad = await api(`/api/business/${biz}/funding/offers`, { method: "PUT", body: { offers: [{ ...offer, principal: "abc" }] } });
      assert.equal(bad.status, 400, "an invalid save is refused");
      assert.equal((await api(`/api/business/${biz}/funding/offers`, { method: "PUT", body: { offers: [offer] }, csrf: false })).status, 403, "saving needs the CSRF token");
      await api(`/api/business/${biz}/funding/offers`, { method: "PUT", body: { offers: [offer] } }); // replaced, not duplicated
      const got = await api(`/api/business/${biz}/funding/offers`);
      assert.equal(got.json.forms.length, 1, "saving again replaces the set");
      assert.equal(got.json.offers[0].id, "Loan A");

      // Contract check: a matching contract, then one with a higher fee and a later first payment.
      const match = await api(`/api/business/${biz}/funding/contract-check`, { body: { offerLabel: "Loan A", contract: offer } });
      assert.equal(match.status, 200);
      assert.equal(match.json.check.matches, true);
      const worse = await api(`/api/business/${biz}/funding/contract-check`, { body: { offerLabel: "Loan A", contract: { ...offer, upfrontFees: "1500.00" } } });
      const fee = worse.json.check.differences.find((d: any) => d.field === "upfront_fees");
      assert.ok(fee && fee.worse === true && fee.contract === "150000", "a higher fee in the contract is flagged as costing more");
      assert.equal(worse.json.check.extraCostMinor, "50000", "the extra fee of 500.00 is the extra cost");
      assert.equal((await api(`/api/business/${biz}/funding/contract-check`, { body: { contract: offer } })).status, 400, "neither an offer nor a saved name: refused");
      assert.equal((await api(`/api/business/${biz}/funding/contract-check`, { body: { offerLabel: "No such offer", contract: offer } })).status, 404, "an unknown saved offer name");

      // Signed funding limits: a new mandate version (signed with the dev owner key by the script) changes what the comparison flags.
      const none = await api(`/api/business/${biz}/funding/compare`, { body: { offers: [offer] } });
      assert.equal(none.json.limits.costBps, null, "no funding limits before they are signed");
      const sign = spawnSync("bun", ["scripts/mandate-funding-limits.ts", biz], { env: { ...process.env, FUNDING_MAX_COST_BPS: "5000", FUNDING_MAX_AMOUNT_MINOR: "1500000" }, encoding: "utf8" });
      assert.equal(sign.status, 0, `signing the limits failed: ${sign.stderr || sign.stdout}`);
      const capped = await api(`/api/business/${biz}/funding/compare`, { body: { offers: [offer] } });
      assert.equal(capped.json.limits.costBps, 5000);
      assert.equal(capped.json.limits.mandateValid, true);
      const o0 = capped.json.comparison.offers[0];
      assert.equal(o0.withinCostCap, false, "182.96% is above the signed 50%");
      assert.equal(o0.withinAmountCap, false, "20,000.00 is above the signed 15,000.00");
      assert.ok(o0.warnings.some((w: string) => w.includes("above your limit")) && o0.warnings.some((w: string) => w.includes("funding limit you signed")));
      log("funding store and contract check: save and replace, bad save refused, matching contract matches, a higher fee is flagged as costing 500.00 more, unknown offers refused; signed limits (50% a year, 15,000.00) flag the offer");
    }
    {
      // Financing-option matching and the declared trading start: sessions, CSRF, company scoping and roles.
      const mUrl = `/api/business/${biz}/funding/match`;
      const pUrl = `/api/business/${biz}/funding/profile`;
      assert.equal((await api(mUrl, { body: {}, cookie: false, csrf: false })).status, 401, "match: no session");
      assert.equal((await api(mUrl, { body: {}, csrf: false })).status, 403, "match: no CSRF token");
      assert.equal((await api("/api/business/50d04f73-3186-40b1-96fe-46f478ea6134/funding/match", { body: {} })).status, 403, "match: another company");
      const m = await api(mUrl, { body: {} });
      assert.equal(m.status, 200, JSON.stringify(m.json));
      assert.equal(m.json.match.results.length, 6);
      assert.ok(m.json.match.results.every((r: any) => r.indicative === true && r.notice.includes("not a quote")));
      assert.ok(["declared", "bank_statement"].includes(m.json.profile.historySource), "the match response carries the profile and where history comes from");
      assert.equal((await api(pUrl, { method: "PUT", body: { tradingSince: "2021-03-01" }, cookie: false, csrf: false })).status, 401, "profile: no session");
      assert.equal((await api(pUrl, { method: "PUT", body: { tradingSince: "2021-03-01" }, csrf: false })).status, 403, "profile: no CSRF token");
      assert.equal((await api("/api/business/50d04f73-3186-40b1-96fe-46f478ea6134/funding/profile", { method: "PUT", body: { tradingSince: "2021-03-01" } })).status, 403, "profile: another company");
      const future = await api(pUrl, { method: "PUT", body: { tradingSince: "2099-01-01" } });
      assert.equal(future.status, 400, "a date after the books date is refused");
      assert.ok(/after/.test(future.json.error), future.json.error);
      assert.equal((await api(pUrl, { method: "PUT", body: { tradingSince: "1949-12-31" } })).status, 400, "before 1950 is refused");
      assert.equal((await api(pUrl, { method: "PUT", body: { tradingSince: "2021-03-01" } })).status, 200, "the owner can state it");
      const after = await api(mUrl, { body: {} });
      assert.equal(after.json.profile.historySource, "declared");
      assert.equal(after.json.profile.tradingSince, "2021-03-01");
      assert.equal(await asApprover(async () => (await api(pUrl, { method: "PUT", body: { tradingSince: "2000-01-01" } })).status), 403, "an approver cannot state it");
      assert.equal((await api(mUrl, { body: {} })).json.profile.tradingSince, "2021-03-01", "and it did not change");
      log("matching: no session 401, no CSRF 403, other company 403, owner 200 with profile and history source; trading start: bad dates 400, owner 200, approver 403");
    }
    {
      // Alerts and the monitor: sessions, CSRF, company scoping, roles.
      const runUrl = `/api/business/${biz}/monitor/run`;
      const listUrl = `/api/business/${biz}/alerts`;
      assert.equal((await api(listUrl, { cookie: false, csrf: false })).status, 401, "alerts: no session");
      assert.equal((await api("/api/business/50d04f73-3186-40b1-96fe-46f478ea6134/alerts")).status, 403, "alerts: another company");
      assert.equal((await api(runUrl, { body: {}, cookie: false, csrf: false })).status, 401, "monitor run: no session");
      assert.equal((await api(runUrl, { body: {}, csrf: false })).status, 403, "monitor run: no CSRF token");
      assert.equal((await api("/api/business/50d04f73-3186-40b1-96fe-46f478ea6134/monitor/run", { body: {} })).status, 403, "monitor run: another company");
      const ran = await api(runUrl, { body: {} });
      assert.equal(ran.status, 200, JSON.stringify(ran.json));
      assert.ok(ran.json.counts && typeof ran.json.asOf === "string");
      const again = await api(runUrl, { body: {} });
      assert.ok(again.status === 200 && again.json.fromCache === true, "a second run within 30 seconds returns the stored result");
      const got = await api(listUrl);
      assert.equal(got.status, 200, JSON.stringify(got.json));
      assert.ok(Array.isArray(got.json.alerts) && got.json.lastRunAt && got.json.counts, "alerts and the last run time are returned");
      const anAlert = got.json.alerts[0];
      assert.ok(anAlert && anAlert.severity && anAlert.title && anAlert.refs.route, "the books of this story have at least one alert, with a title and a place to go");
      assert.equal((await api(`/api/alerts/${anAlert.id}/acknowledge`, { body: {}, cookie: false, csrf: false })).status, 401, "acknowledge: no session");
      assert.equal((await api(`/api/alerts/${anAlert.id}/acknowledge`, { body: {}, csrf: false })).status, 403, "acknowledge: no CSRF token");
      assert.equal(await asApprover(async () => (await api(listUrl)).status), 200, "an approver can read alerts");
      assert.equal(await asApprover(async () => (await api(runUrl, { body: {} })).status), 200, "an approver can run the check");
      const ack = await api(`/api/alerts/${anAlert.id}/acknowledge`, { body: {} });
      assert.equal(ack.status, 200, JSON.stringify(ack.json));
      assert.equal((await api(listUrl)).json.alerts.find((a: any) => a.id === anAlert.id).status, "acknowledged", "acknowledged alerts stay visible");
      const other2 = await api("/api/demo/clone", { method: "POST", body: {} }); // the session now works in the new company
      assert.equal(other2.status, 200);
      const stranger = (await api(`/api/business/${other2.json.id}/alerts`)).json.alerts[0];
      assert.equal((await api(`/api/alerts/${anAlert.id}/acknowledge`, { body: {} })).status, 403, "an alert of another company cannot be acknowledged");
      assert.ok(stranger === undefined || stranger.id !== anAlert.id);
      assert.equal((await api("/api/auth/business", { body: { businessId: biz } })).status, 200, "back to the story's company");
      log("alerts: no session 401, no CSRF 403, other company 403, owner 200 (list, run, 30 s cache, acknowledge), approver 200 (list, run)");
    }
    for (const path of ["/room", "/room/commitments", "/room/funding", `/room/case?run=${shortageRunId}`, "/room/safety", "/room/safety?tab=limits", "/room/safety?tab=records", "/dev"]) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(res.status, 200, `${path} renders for a signed-in owner`);
      if (path === "/room/funding") { const g = await api(`/api/business/${biz}/funding/match`); assert.ok(g.status === 200 && g.json.match.results.length === 6 && g.json.extras, "the products section's data (GET match) is served"); }
    }
    for (const [from, to] of [["/room/scoreboard", "/room/safety?tab=results"], ["/room/mandate", "/room/safety?tab=limits"], ["/room/evidence", "/room/safety?tab=records"]]) {
      const res = await fetch(`${BASE}${from}`, { headers: { cookie }, redirect: "manual" });
      assert.ok([307, 308].includes(res.status) && (res.headers.get("location") ?? "").endsWith(to), `${from} redirects to ${to}`);
    }
    assert.equal((await fetch(`${BASE}/demo/actions`, { headers: { cookie }, redirect: "manual" })).status, 404, "the old /demo pages are gone");
    log("pages: today, orders and quotes, funding, plans, safety and records (three tabs) and the demo tools page render; old URLs redirect; /demo is gone");
    // The decision-room components render with the REAL API data of this story (server-side render; catches data-shape mistakes).
    {
      const { renderToString } = await import("react-dom/server");
      const { createElement: h } = await import("react");
      const parts = await import("../src/ui/case/parts");
      const { Chart } = await import("../src/ui/Chart");
      const caseNow = (await api(`/api/business/${biz}/cases/${shortageRunId}`)).json;
      const names = Object.fromEntries(caseNow.counterparties.map((c: any) => [c.id, c.name]));
      const runs = caseNow.runs as any[];
      const lastRun = runs[runs.length - 1];
      const html = [
        renderToString(h(parts.PlanTable, { run: lastRun, names, cur: "GBP", selected: lastRun.plans[0].id, onSelect: () => {}, onSign: () => {}, onEdit: () => {}, canSign: true })),
        renderToString(h(parts.Timeline, { run: lastRun })),
        ...caseNow.authorisations.map((a: any) => renderToString(h(parts.ExecutionPanel, { auth: a, names, cur: "GBP", busy: false, onExecute: () => {} }))),
        ...caseNow.authorisations.filter((a: any) => a.execution?.verification).map((a: any) => renderToString(h(parts.VerificationPanel, { v: a.execution.verification, cur: "GBP" }))),
      ].join("");
      assert.ok(html.includes("Do nothing") && html.includes("Verification passed") && html.includes("Scheduled in the practice bank"), "components render the story's data");
      const lines = (await api(`/api/business/${biz}/room/forecast?runId=${lastRun.id}&planId=${lastRun.plans[0].id}&authorisationId=${finalAuth}`)).json;
      const chart = renderToString(h(Chart, { currency: "GBP", reserveMinor: lines.reserveMinor, series: [{ key: "a", label: "Do nothing", weeks: lines.doNothing.weeks, color: "#000" }, { key: "b", label: "Executed", weeks: lines.agreed.weeks, color: "#0a0" }] }));
      assert.ok(chart.includes("<svg"));
      // Rescue My Cash Flow screens: the cash picture (cause, certainty, gaps) and the outcome summary come from the same real data.
      const rescue = await import("../src/ui/rescue");
      const room = (await api(`/api/business/${biz}/room`)).json;
      const picture = renderToString(h(rescue.CashPicture, { room, cur: "GBP", latestRunId: shortageRunId, busy: false, onAsk: () => {} }));
      assert.ok(picture.includes("How sure is this forecast?") && picture.includes("Confirmed"), "cash picture shows the certainty breakdown");
      const doneAuth = caseNow.authorisations.find((a: any) => a.authorisation.id === finalAuth);
      const outcome = renderToString(h(rescue.OutcomeSummary, { auth: doneAuth, reason: runs[0].trigger.reason, doNothing: lines.doNothing, agreed: lines.agreed, reserveMinor: lines.reserveMinor, cur: "GBP", exportBase: `/api/business/${biz}/cases/${shortageRunId}/export` }));
      assert.ok(outcome.includes("Attempted") && outcome.includes("Verified") && outcome.includes("Download the evidence"), "outcome summary renders attempted, executed, verified and the evidence links");
      assert.ok(!outcome.includes("Not confirmed") || doneAuth.execution.verification?.ok === false, "a passing independent check is what makes it a success");
      log("components: plan table, timeline, execution, verification, chart, cash picture and outcome summary render with the real data");
    }
    // the older owner routes now need the password too
    {
      const acts = (await api(`/api/business/${biz}/actions`)).json as any[];
      const target = acts?.[0]?.id ?? "00000000-0000-4000-8000-000000000001";
      assert.equal((await api(`/api/actions/${target}/approve`, { body: { approvedBy: "x", confirmations: 1 } })).status, 403, "approve without the password is refused");
      assert.equal((await api(`/api/business/${biz}/console`, { body: { request: { kind: "read.state" }, idempotencyKey: "k-nopw" } })).status, 403, "console without the password is refused");
      log("older routes: approve and console refuse a request without the step-up password");
    }
    // ---------- 6. evidence export: re-verifiable offline, tamper-evident, no secrets ----------
    {
      const fetchText = async (fmt: string) => (await fetch(`${BASE}/api/business/${biz}/cases/${shortageRunId}/export?format=${fmt}`, { headers: { cookie } }));
      const jr = await fetchText("json"), hr = await fetchText("html");
      assert.equal(jr.status, 200); assert.equal(hr.status, 200);
      const jsonText = await jr.text(), htmlText = await hr.text();
      const dir = mkdtempSync(join(tmpdir(), "export-"));
      const jf = join(dir, "e.json"), hf = join(dir, "e.html"), tf = join(dir, "tampered.json");
      writeFileSync(jf, jsonText); writeFileSync(hf, htmlText);
      const run = (f: string) => spawnSync("node", [join("scripts", "verify-export.mjs"), f], { encoding: "utf8" });
      const ok = run(jf), okHtml = run(hf);
      assert.equal(ok.status, 0, ok.stdout.slice(-600));
      assert.equal(okHtml.status, 0, okHtml.stdout.slice(-600));
      const bundle = JSON.parse(jsonText);
      const checks = (ok.stdout.match(/^PASS/gm) ?? []).length;
      // tamper 1: change a number inside a log record; tamper 2: change the signed terms; tamper 3: flip a signature
      const t1 = JSON.parse(jsonText); t1.log.records[Math.floor(t1.log.records.length / 2)].detail = { forged: true };
      const t2 = JSON.parse(jsonText); t2.authorisations[0].terms.confirmations = 1 + (t2.authorisations[0].terms.confirmations === 1 ? 1 : -1);
      const t3 = JSON.parse(jsonText); t3.authorisations[0].signature = t3.authorisations[0].signature.slice(0, -4) + "AAAA";
      for (const [name, t] of [["a log record", t1], ["the signed terms", t2], ["a signature", t3]] as const) {
        writeFileSync(tf, JSON.stringify(t));
        assert.equal(run(tf).status, 1, `editing ${name} is detected`);
      }
      // no secrets: the private key, any password, session or CSRF token, API key patterns (counts only)
      const secrets = [process.env.OWNER_SIGNING_PRIVATE_KEY, OWNER.password, APPROVER.password, cookie.split("=")[1], csrf].filter((x): x is string => !!x && x.length > 6);
      const hits = secrets.filter((x) => jsonText.includes(x) || htmlText.includes(x)).length + (/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}/.test(jsonText) ? 1 : 0);
      assert.equal(hits, 0, "the export contains no secret");
      assert.ok(!jsonText.includes("Production starts when the deposit"), "no raw document text in the export");
      log(`export: JSON and HTML re-verified offline by scripts/verify-export.mjs (${checks} checks passed); editing a log record, the signed terms or a signature is detected; secrets found: 0`);
      void bundle;
    }
    {
      const leaked = [process.env.OWNER_SIGNING_PRIVATE_KEY, OWNER.password, APPROVER.password].filter((x): x is string => !!x && x.length > 6).filter((x) => serverOut.includes(x)).length;
      assert.equal(leaked, 0, "the server output contains no key or password");
      log(`server output: ${serverOut.length} characters, secrets found: ${leaked}`);
    }
    const out = await api("/api/auth/logout", { method: "POST", body: {} });
    assert.equal(out.status, 200);
    assert.equal((await api(`/api/business/${biz}/room`)).status, 401, "after logout the session is gone");
    console.log(`e2e smoke (${RECORD ? "RECORD with the real model" : REPLAY ? "REPLAY of the canonical recordings" : "offline, mock provider"}): ok`);
  } finally {
    stopServer();
  }
}
await main().catch((e) => { stopServer(); console.error(e); process.exit(1); });
