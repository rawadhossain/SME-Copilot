/* eslint-disable @typescript-eslint/no-explicit-any */
// Browser regression test for the Rescue My Cash Flow journey (bun run test:browser). It starts the app on its own port (mock provider, no network,
// no real money), drives a REAL headless Chromium-based browser over the DevTools protocol (scripts/browser/driver.ts, no dependency) and checks what
// is actually rendered:
//   A. The whole journey through the screens: sign in, shortage and its causes, the Ask box, comparing plans, the signing review (at phone width, with the
//      schedule of payments), a plan that needs a second approver (cannot run before it), the approver's own screen, a counterparty refusal and re-plan,
//      the run, and the final outcome which must agree with the independent verifier; evidence reachable.
//   B. Failure paths, each in a fresh company: a failed independent check, a clean rollback and an unclean rollback must never read as success.
// Every scenario runs in its own throwaway copy of the demo company, so it is safe to rerun. If no browser is installed it says NOT RUN (set BROWSER_PATH).
// It stops only the processes it started, by PID.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import postgres from "postgres";
import { Browser, findBrowser, type Page } from "./browser/driver";
import { makeSignaturePng } from "./png-fixture";

const PORT = Number(process.env.BROWSER_TEST_PORT ?? 3112);
const BASE = `http://localhost:${PORT}`;
const OWNER = { email: "owner@mercer-vale.example", password: "Ledger-Owner-2026" };
const APPROVER = { email: "finance@mercer-vale.example", password: "Ledger-Approver-2026" };
const log = (s: string) => console.log(`  ${s}`);
/** Saves a screenshot of the current page when BROWSER_SHOTS=<folder> is set (for people to look at; the test never depends on it). */
async function shot(page: Page, name: string) {
  const dir = process.env.BROWSER_SHOTS;
  if (!dir) return;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const r = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(r.data, "base64"));
}

// ---------------------------------------------------------------- the app server
let server: ChildProcess | null = null;
let serverOut = ""; // kept so a failure can show what the server said
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), LLM_PROVIDER: "mock", LLM_MODE: "live", LLM_API_KEY: "", SHORTAGE_AUTO_PLAN: "on" } as NodeJS.ProcessEnv;
  delete env.LLM_RECORDINGS_DIR;
  server = spawn(process.execPath.includes("bun") ? "node" : process.execPath, [join("node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT)], { env, stdio: "pipe" });
  let out = "";
  server.stdout?.on("data", (d) => { out += d; serverOut += d; });
  server.stderr?.on("data", (d) => { out += d; serverOut += d; });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await fetch(`${BASE}/login`, { redirect: "manual" }); if (r.status < 500) return; } catch { /* not up yet */ }
    if (server.exitCode !== null) throw new Error(`server exited: ${out.slice(-400)}`);
  }
  throw new Error(`server did not start: ${out.slice(-400)}`);
}
function stopServer() {
  if (!server?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"]);
  else server.kill();
}

// ---------------------------------------------------------------- a small API client with its own cookie jar (setup only; assertions are in the browser)
class Api {
  cookie = ""; csrf = "";
  async call(path: string, body?: unknown, method?: string) {
    const headers: Record<string, string> = { "content-type": "application/json", origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf) headers["x-csrf-token"] = this.csrf;
    const res = await fetch(`${BASE}${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set?.startsWith("sme_session=")) this.cookie = set.split(";")[0];
    return { status: res.status, json: ((await res.json().catch(() => null)) ?? {}) as any };
  }
  async login(who: { email: string; password: string }) {
    const r = await this.call("/api/auth/login", who);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    this.csrf = r.json.csrfToken;
  }
}

const BOOKS = ["chase_overdue", "early_payment_discount"];
const has = (p: any, kinds: string[]) => p.levers.some((l: any) => kinds.includes(l.kind));
const pickIndex = (plans: any[]) => { const i = plans.findIndex((p) => has(p, BOOKS)); return i >= 0 ? i : 0; };

/** A fresh copy of the demo company with both sample documents confirmed: a shortage and a planning run exist. */
async function newCompany(owner: Api) {
  const clone = await owner.call("/api/demo/clone", {});
  assert.equal(clone.status, 200, JSON.stringify(clone.json));
  const biz = clone.json.id as string;
  const samples = (await owner.call("/api/demo/samples")).json.samples as { filename: string; kind: string; text: string }[];
  const ids: string[] = [];
  for (const s of samples) {
    const up = await owner.call(`/api/business/${biz}/documents`, { filename: s.filename, kind: s.kind, text: s.text });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    ids.push(up.json.extraction.id);
  }
  let runId: string | null = null;
  for (const id of ids) { const c = await owner.call(`/api/extractions/${id}/confirm`, { confirmedBy: "Alex Mercer (owner)" }); assert.equal(c.status, 200, JSON.stringify(c.json)); runId = c.json.shortage?.runId ?? runId; }
  assert.ok(runId, "confirming the documents flagged a shortage and started a planning run");
  return { biz, runId: runId! };
}

/** Signs a plan through the real routes: the owner's confirmation, then the approver's own. Returns the authorisation id (status authorised, nothing run). */
async function apiSign(owner: Api, biz: string, runId: string, plan: any): Promise<string> {
  const body = { runId, planId: plan.id, confirmations: 2 };
  const prev = await owner.call(`/api/business/${biz}/plan-authorisations/preview`, body);
  assert.equal(prev.status, 200, JSON.stringify(prev.json));
  const ok = await owner.call(`/api/business/${biz}/plan-authorisations`, { ...body, letters: prev.json.letters, signatureImage: makeSignaturePng(), password: OWNER.password });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  if (ok.json.status === "awaiting_second") {
    const approver = new Api();
    await approver.login(APPROVER);
    assert.equal((await approver.call("/api/auth/business", { businessId: biz })).status, 200);
    const good = await approver.call(`/api/plan-authorisations/${ok.json.authorisationId}/second-approval`, { password: APPROVER.password });
    assert.equal(good.status, 200, JSON.stringify(good.json));
  }
  return ok.json.authorisationId as string;
}

/** Round 0 refused by the buyer, re-plan, round 1 signed and ready to run. */
async function reachSignedRound2(owner: Api, biz: string, runId: string): Promise<{ authId: string; runId: string }> {
  const c0 = (await owner.call(`/api/business/${biz}/cases/${runId}`)).json;
  const sets0 = c0.runs[0].plans.map((p: any) => p.plan);
  const a1 = await apiSign(owner, biz, runId, sets0[pickIndex(sets0)]);
  const r1 = await owner.call(`/api/plan-authorisations/${a1}/execute`, {});
  assert.equal(r1.json.status, "needs_replan", `round one is refused by the buyer: ${JSON.stringify(r1.json).slice(0, 200)}`);
  const rp = await owner.call(`/api/plan-authorisations/${a1}/replan`, {});
  assert.equal(rp.status, 200, JSON.stringify(rp.json));
  const c1 = (await owner.call(`/api/business/${biz}/cases/${runId}`)).json;
  const last = c1.runs.at(-1);
  const sets1 = last.plans.map((p: any) => p.plan);
  return { authId: await apiSign(owner, biz, last.id, sets1[pickIndex(sets1)]), runId: last.id };
}

// ---------------------------------------------------------------- browser helpers
async function uiLogin(page: Page, who: { email: string; password: string }, biz: string) {
  // The dev server may reload the page under us while it compiles, so the whole sign-in is attempted up to three times.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(`${BASE}/login`);
      await page.waitFor(`(()=>{const e=document.querySelector('input[type=email]');return e&&e.getClientRects().length>0})()`, "the sign-in form", 20_000);
      // The form is hydrated by React a moment after it appears; text typed before that is thrown away. Type, wait, and check it stuck.
      for (let i = 0; ; i++) {
        await page.type("input[type=email]", who.email);
        await page.type("input[type=password]", who.password);
        await page.sleep(500);
        const stuck = await page.eval<boolean>(`document.querySelector('input[type=email]').value === ${JSON.stringify(who.email)} && document.querySelector('input[type=password]').value === ${JSON.stringify(who.password)}`);
        if (stuck) break;
        assert.ok(i < 6, "the sign-in form kept the typed values");
      }
      await page.waitFor(`[...document.querySelectorAll('button')].some(b=>/^Sign in/.test(b.innerText)&&!b.disabled&&b.getClientRects().length>0)`, "the Sign in button", 20_000);
      await page.click("Sign in", 0, "button");
      await page.waitFor(`location.pathname.startsWith('/room')`, "the app after sign-in", 30_000);
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
  const st = await page.eval<number>(`(async()=>{const s=await (await fetch('/api/auth/session')).json();return (await fetch('/api/auth/business',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':s.csrfToken},body:JSON.stringify({businessId:${JSON.stringify(biz)}})})).status})()`);
  assert.equal(st, 200, "the browser session works in this company");
}
async function uiLogout(page: Page) {
  await page.eval(`(async()=>{const s=await (await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'x-csrf-token':s.csrfToken}})})()`);
}
const SUCCESS_TEXT = ["Fixed, and checked.", "It worked, and an independent check confirms it."];
const noSuccess = async (page: Page, why: string) => { const t = await page.text(); for (const s of SUCCESS_TEXT) assert.ok(!t.includes(s), `${why}: the page must not say "${s}"`); };

/** Opens the signing dialog for plan #idx and walks it: review (with the schedule), letters, typed signature and password. Returns the schedule table rows shown. */
async function uiSign(page: Page, idx: number, password: string, mobile: boolean, wrongFirst = false): Promise<string[]> {
  await page.click("Review and sign", idx);
  await page.waitFor(`document.querySelector('dialog[open]')`, "the signing dialog");
  await page.waitText("Money it would schedule");
  const rows = await page.eval<string[]>(`[...document.querySelectorAll('dialog[open] section[aria-label="Money this plan would schedule"] tbody tr')].map(r=>r.innerText.replace(/\\s+/g,' ').trim())`);
  const dialogText = await page.eval<string>(`document.querySelector('dialog[open]').innerText`);
  assert.ok(dialogText.includes("proposed, not agreed") && /Lowest balance with this plan/.test(dialogText) && /Your limits:/.test(dialogText), "the review says it is proposed and shows the cash effect and the limits");
  if (mobile) assert.equal(await page.overflow(), 0, "the signing dialog does not overflow a phone screen (review step)");
  await shot(page, "sign-step1-review");
  await page.click("Next: write the proposals", 0, "button");
  await page.waitFor(`[...document.querySelectorAll('dialog[open] textarea,dialog[open] input')].some(e=>String(e.value).startsWith('Dear '))`, "the first-draft letter greeting");
  if (mobile) assert.equal(await page.overflow(), 0, "the letters step does not overflow a phone screen");
  await page.click("Next: sign", 0, "button");
  await page.waitText("Confirm it is you");
  await page.click("Type it", 0, "[role=tab]");
  await page.waitFor(`document.querySelector('dialog[open] input[autocomplete=off]')`, "the typed signature box");
  await page.type("dialog[open] input[autocomplete=off]", "Alex Mercer");
  if (wrongFirst) {
    // A recoverable error: a wrong password signs nothing, says so in an alert, keeps the dialog open and the typed signature, and the right password then works.
    await page.type("dialog[open] input[type=password]", "not-the-password");
    await page.waitFor(`[...document.querySelectorAll('dialog[open] button')].some(b=>/^Sign and/.test(b.innerText)&&!b.disabled)`, "the Sign button to become enabled");
    await page.click("Sign and", 0, "dialog[open] button");
    await page.waitFor(`document.querySelector('dialog[open] [role=alert]')`, "the error banner");
    const alertText = await page.eval<string>(`document.querySelector('dialog[open] [role=alert]').innerText`);
    assert.ok(/password was not accepted, so nothing was signed/.test(alertText), `a wrong password is explained: ${alertText}`);
    assert.ok(await page.eval<boolean>(`!!document.querySelector('dialog[open]')`), "the dialog stays open after a wrong password");
    await shot(page, "sign-wrong-password");
  }
  await page.type("dialog[open] input[type=password]", password);
  await shot(page, "sign-step3");
  if (mobile) assert.equal(await page.overflow(), 0, "the signing step does not overflow a phone screen");
  await page.waitFor(`[...document.querySelectorAll('dialog[open] button')].some(b=>/^Sign and/.test(b.innerText)&&!b.disabled)`, "the Sign button to become enabled");
  await page.click("Sign and", 0, "dialog[open] button");
  await page.waitFor(`!document.querySelector('dialog[open]')`, "the dialog to close after signing");
  return rows;
}

async function uiApprove(page: Page, biz: string, expectRows: string[]) {
  await uiLogout(page);
  await uiLogin(page, APPROVER, biz);
  await page.goto(`${BASE}/room/approvals`);
  await page.waitText("A plan is waiting for a second approval");
  const t = await page.text();
  assert.ok(t.includes("Money it would schedule") && t.includes("proposed, not agreed"), "the approver sees the schedule the owner saw");
  await shot(page, "approver");
  const shown = await page.eval<string[]>(`[...document.querySelectorAll('section[aria-label="Money this plan would schedule"] tbody tr')].map(r=>r.innerText.replace(/\\s+/g,' ').trim())`);
  assert.deepEqual(shown, expectRows, "the approver sees exactly the same payments and receipts as the owner's signing review");
  await page.type("input[type=password]", APPROVER.password);
  await page.waitFor(`[...document.querySelectorAll('button')].some(b=>/^Confirm this plan/.test(b.innerText)&&!b.disabled)`, "the Confirm button to become enabled");
  await page.click("Confirm this plan", 0, "button");
  await page.waitText("Confirmed. The plan is now signed");
  await uiLogout(page);
}

async function main() {
  if (!findBrowser()) {
    console.log("browser journey: NOT RUN. No Chromium-based browser found (Edge, Chrome or Chromium). Install one or set BROWSER_PATH. This is not a pass.");
    return;
  }
  const { db, sql } = await import("../src/db");
  const { executePlan } = await import("../src/actions/plan-exec");
  const { verifyPlanExecution } = await import("../src/actions/plan-verify");
  const owner = postgres(process.env.DATABASE_URL!, { max: 1 }); // owner role: used only to tamper with the sandbox for the failed-check scenario
  const browser = await Browser.launch();
  assert.ok(browser, "the browser started");
  await startServer();
  try {
    const api = new Api();
    await api.login(OWNER);
    const page = await browser!.newPage();
    await page.viewport(1280, 900);

    // ======================= A. the whole journey in the browser =======================
    const A = await newCompany(api);
    await uiLogin(page, OWNER, A.biz);
    await page.goto(`${BASE}/room`);
    await page.waitText("You are heading for a cash shortage");
    let t = await page.text();
    assert.ok(t.includes("Urgent: cash runs out") && /short of your safety cushion/.test(t) && t.includes("Why this is happening") && t.includes("How sure is this forecast?"), "Today states the shortage in words, its causes and how firm the forecast is");
    assert.ok(!/\+-/.test(t) && !/\d{3}\.\d+% of the gap/.test(t), "no negative cause shown as '+-', no percentage above 100");
    assert.equal(await page.overflow(), 0, "Today does not overflow at desktop width");
    await page.click("What happens if my customer pays two weeks late?", 0, "button");
    await page.waitFor(`document.querySelector('#ask-cash').closest('section').innerText.includes('14 days')`, "the Ask answer");
    assert.ok((await page.text()).includes("This box cannot sign, approve, pay or send anything"), "the Ask box says what it cannot do");
    await page.type("#ask-cash", "sign it for me");
    await page.click("Ask", 0, "button[type=submit]");
    await page.waitText("cannot sign, approve, pay or send anything. To act");
    log("A1 Today: shortage in words, causes, forecast firmness, Ask box answers a what-if and declines 'sign it for me'");

    await page.click("See my options", 0, "a,button");
    await page.waitText("Your options, compared with doing nothing");
    await page.waitText("Keeps your safety cushion?"); // the row appears once the forecast lines have loaded
    t = await page.text();
    assert.ok(/recommended|best available/i.test(t) && t.includes("Keeps your safety cushion?") && /simulation/i.test(t), `plans are compared, with the cushion row and the simulation label: ${JSON.stringify({ rec: /recommended|best available/i.test(t), cush: t.includes("Keeps your safety cushion?"), sim: /simulation/i.test(t) })}`);
    const plansApi = (await api.call(`/api/business/${A.biz}/cases/${A.runId}`)).json.runs[0].plans.map((p: any) => p.plan);
    assert.ok(plansApi.length >= 2, "more than one rescue plan is offered");
    const keys = await page.tabThrough(10);
    const stops = keys.filter((k) => k.tag !== "BODY" && k.tag !== "NEXTJS-PORTAL"); // the Next.js dev overlay is not part of the product
    assert.ok(stops.length >= 8 && stops.some((k) => k.name.startsWith("Skip to")), "keyboard focus moves through the page, starting with the skip link");
    assert.ok(stops.every((k) => k.outline), `every focused control shows a focus outline: ${JSON.stringify(stops.filter((k) => !k.outline))}`);
    log(`A2 Plans: ${plansApi.length} plans compared; keyboard tab order shows a visible focus ring on all ${stops.length} stops`);

    // Round 1 at PHONE width: review, sign, wait for the second approver.
    await page.viewport(390, 844, true);
    await page.goto(`${BASE}/room/case?run=${A.runId}`);
    await page.waitText("Your options, compared with doing nothing");
    assert.equal(await page.overflow(), 0, "the plans page does not overflow a phone screen");
    assert.ok(await page.eval(`document.querySelectorAll('article[aria-label^="Plan "]').length >= 2`), "on a phone each plan is a card");
    const idx0 = pickIndex(plansApi);
    const rows1 = await uiSign(page, idx0, OWNER.password, true, true);
    assert.ok(rows1.length >= 1, `the signing review listed ${rows1.length} scheduled item(s)`);
    await shot(page, "waiting-second-mobile");
    await page.viewport(1280, 900);
    await page.waitText("Waiting for a second approver");
    await shot(page, "waiting-second-desktop");
    assert.ok(!(await page.eval<boolean>(`[...document.querySelectorAll('button')].some(b=>/^Run the plan/.test(b.innerText))`)), "no Run button while the second approval is missing");
    const c1 = (await api.call(`/api/business/${A.biz}/cases/${A.runId}`)).json;
    const auth1 = c1.authorisations.at(-1).authorisation;
    assert.equal(auth1.status, "awaiting_second");
    const early = await api.call(`/api/plan-authorisations/${auth1.id}/execute`, {});
    assert.ok(early.status >= 400 && early.json.status !== "completed", `a plan waiting for its second approver cannot run (HTTP ${early.status})`);
    const stillWaiting = (await api.call(`/api/business/${A.biz}/cases/${A.runId}`)).json.authorisations.at(-1);
    assert.ok(!stillWaiting.execution, "no execution row was created");
    log(`A3 signing at phone width: review listed ${rows1.length} payment/receipt rows, no overflow; the plan waits for a second approver and cannot be run (HTTP ${early.status})`);

    await uiApprove(page, A.biz, rows1);
    log("A4 second approver: signs in as themselves, sees the same schedule as the owner, confirms with their own password");

    await uiLogin(page, OWNER, A.biz);
    await page.goto(`${BASE}/room/case?run=${A.runId}`);
    await page.click("Run the plan", 0, "button");
    await page.waitFor(`document.body.innerText.includes('Someone did not accept your terms')`, "the buyer's refusal", 90_000);
    t = await page.text();
    assert.ok(/Refused|Countered outside your terms/.test(t) && t.includes("Revise the terms myself") && t.includes("Ask the assistant to plan again"), "a refusal shows what they said and the ways forward");
    await noSuccess(page, "after a refusal");
    await shot(page, "refusal");
    log("A5 refusal: 'Someone did not accept your terms' with the structured answer and the choices; no success shown");

    await page.click("Ask the assistant to plan again", 0, "button");
    await page.waitText("Re-plan 1");
    await page.waitFor(`[...document.querySelectorAll('button')].some(b=>/^Review and sign/.test(b.innerText))`, "the new round's plans");
    const c2 = (await api.call(`/api/business/${A.biz}/cases/${A.runId}`)).json;
    const round2Plans = c2.runs.at(-1).plans.map((p: any) => p.plan);
    const rows2 = await uiSign(page, pickIndex(round2Plans), OWNER.password, false);
    await page.waitText("Waiting for a second approver");
    await uiApprove(page, A.biz, rows2);
    await uiLogin(page, OWNER, A.biz);
    await page.goto(`${BASE}/room/case?run=${A.runId}`);
    await page.click("Run the plan", 0, "button");
    await page.waitFor(`document.body.innerText.includes('Fixed, and checked.') || document.body.innerText.includes('The check found a mismatch') || document.body.innerText.includes('rolled back')`, "the run to finish", 120_000);
    t = await page.text();
    const done = (await api.call(`/api/business/${A.biz}/cases/${A.runId}`)).json.authorisations.at(-1);
    assert.equal(done.execution.status, "completed", "the run completed");
    assert.equal(done.execution.verification.ok, true, "the independent verifier passed");
    assert.ok(t.includes("Fixed, and checked.") && t.includes("It worked, and an independent check confirms it.") && t.includes("Verification passed"), "the page says success because the verifier passed");
    const scheduledOnScreen = await page.eval<string>(`document.body.innerText`);
    for (const r of rows2) { const amount = r.match(/£[\d,]+\.\d\d/)?.[0]; if (amount && /out/.test(r)) assert.ok(scheduledOnScreen.includes(amount), `the reviewed payment ${amount} appears among the scheduled items`); }
    assert.ok(/attempted\s*\d+/i.test(t.replace(/\n+/g, " ")) && /verified\s*\d+/i.test(t.replace(/\n+/g, " ")), "the outcome shows attempted and verified counts");
    const href = await page.eval<string>(`[...document.querySelectorAll('a')].find(a=>a.innerText.startsWith('Download the evidence (readable)')).getAttribute('href')`);
    const ev = await page.eval<number>(`fetch(${JSON.stringify(href)}).then(r=>r.status)`);
    assert.equal(ev, 200, "the evidence export is reachable from the outcome");
    await shot(page, "success");
    log(`A6 run: executed through the sandbox, the page says success only because the independent check passed (${done.execution.status}, verification ok); reviewed payments appear in the schedule; evidence export reachable (HTTP ${ev})`);

    // ======================= B. failure paths: never a success message =======================
    const scenario = async (name: string) => {
      const o = new Api();
      await o.login(OWNER);
      const c = await newCompany(o);
      const s = await reachSignedRound2(o, c.biz, c.runId);
      return { o, ...c, ...s, name };
    };
    const show = async (s: { biz: string; runId: string }) => {
      await uiLogout(page);
      await uiLogin(page, OWNER, s.biz);
      await page.goto(`${BASE}/room/case?run=${s.runId}`);
    };

    // B1. the independent check fails
    {
      const s = await scenario("verification failure");
      const r = await executePlan(db, s.authId);
      assert.equal(r.status, "completed");
      const hit = await owner`UPDATE sandbox_payments SET amount_minor = amount_minor + 100000 WHERE business_id = ${s.biz} RETURNING id`;
      const hit2 = hit.length ? hit : await owner`UPDATE sandbox_receipts SET amount_minor = amount_minor + 100000 WHERE business_id = ${s.biz} RETURNING id`;
      assert.ok(hit2.length > 0, "something in the sandbox was changed to break the match");
      const v = await verifyPlanExecution(db, s.authId);
      assert.equal(v.ok, false);
      await show(s);
      await page.waitText("The check found a mismatch.");
      t = await page.text();
      assert.ok(t.includes("Not confirmed. Do not treat this as fixed.") && t.includes("Verification FAILED"), "the outcome says not confirmed");
      assert.ok(/verified\s*0/i.test(t.replace(/\n+/g, " ")), "no action is counted as verified");
      await noSuccess(page, "after a failed independent check");
      await shot(page, "b1-verification-failed");
      log("B1 failed independent check: 'The check found a mismatch', 'Not confirmed', verified count 0, no success wording");
    }
    // B2. execution fails part-way and is rolled back cleanly
    {
      const s = await scenario("clean rollback");
      const r = await executePlan(db, s.authId, { beforeStep: (step) => { if (step === "schedule:1") throw new Error("injected failure for the browser test"); } });
      assert.equal(r.status, "rolled_back", `a clean rollback: ${r.status}`);
      await show(s);
      await page.waitText("The plan could not finish, so it was rolled back.");
      t = await page.text();
      assert.ok(t.includes("Not confirmed. Do not treat this as fixed.") && t.includes("nothing is left half-done") && t.includes("ran, then were withdrawn") && t.includes("Was agreed, then withdrawn"), "the page says rolled back, not fixed");
      await noSuccess(page, "after a clean rollback");
      assert.ok(await page.eval<boolean>(`[...document.querySelectorAll('button')].some(b=>/^Review and sign/.test(b.innerText)&&!b.disabled)`), "after a CLEAN rollback the owner can choose and sign again");
      await page.viewport(390, 844, true);
      await page.goto(`${BASE}/room/case?run=${s.runId}`);
      await page.waitText("rolled back");
      assert.equal(await page.overflow(), 0, "the rolled-back case does not overflow a phone screen");
      await page.viewport(1280, 900);
      await shot(page, "b2-clean-rollback-mobile");
      log("B2 clean rollback: 'could not finish, so it was rolled back', not success, Review and sign offered again; no phone overflow");
    }
    // B3. execution fails and the rollback itself is incomplete
    {
      const s = await scenario("unclean rollback");
      const r = await executePlan(db, s.authId, { beforeStep: (step) => { if (step === "schedule:1" || step.startsWith("compensate:")) throw new Error("injected failure for the browser test"); } });
      assert.equal(r.status, "failed", `an unclean rollback: ${r.status}`);
      await show(s);
      await page.waitText("The plan failed and the roll-back was not complete.");
      t = await page.text();
      assert.ok(t.includes("check the practice bank") && /at least one withdrawal failed/.test(t), "the page says the rollback was not complete and what to do");
      assert.ok(t.includes("Still in place: not withdrawn") && !t.includes("Committed"), "agreements that were not withdrawn are not shown as committed successes");
      await noSuccess(page, "after an unclean rollback");
      assert.ok(!(await page.eval<boolean>(`[...document.querySelectorAll('button')].some(b=>/^Review and sign/.test(b.innerText))`)), "there is NO retry button after an unclean rollback");
      await shot(page, "b3-unclean-rollback");
      log("B3 unclean rollback: 'roll-back was not complete', not success, no retry offered");
    }
    console.log("browser journey: ok");
  } finally {
    browser?.close();
    stopServer();
    await owner.end();
    await sql.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); console.error(`--- last server output ---
${serverOut.slice(-1500)}`); stopServer(); process.exit(1); });
