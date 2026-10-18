/* eslint-disable @typescript-eslint/no-explicit-any */
// Browser + route test for the flight simulator (bun run test:simulator). Starts the app on its own port (mock provider), then:
//   1. Route protection: no session, no/wrong CSRF token, cross-origin, another company, bad body. Nothing can be simulated without a session.
//   2. A REAL headless browser, signed in as the owner, in the dedicated demo company (healthy books today): the combined-crisis preset, the
//      numbers shown against an independent API call, the hypothetical labels, a changed assumption and its comparison, a recoverable input error.
//   3. The transition to action in a company that really is short: the simulator's recommendation for an unchanged world is the same plan that
//      Plans offers; simulating creates no authorisation or execution; signing still needs the owner's password.
// Throwaway copies only (the demo company is never touched). Says NOT RUN if no browser is found (set BROWSER_PATH). Stops only its own processes by PID.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import postgres from "postgres";
import { Browser, findBrowser, type Page } from "./browser/driver";
import { createFlightDemo } from "./flight-fixture";

const PORT = Number(process.env.SIM_TEST_PORT ?? (process.env.SIM_USE_RUNNING === "1" ? 3000 : 3113));
const BASE = `http://localhost:${PORT}`;
const OWNER = { email: "owner@mercer-vale.example", password: "Ledger-Owner-2026" };
const APPROVER = { email: "finance@mercer-vale.example", password: "Ledger-Approver-2026" };
const log = (s: string) => console.log(`  ${s}`);
const group = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const gbp = (minor: string) => { const v = BigInt(minor); const a = v < 0n ? -v : v; return `${v < 0n ? "−" : ""}£${group(a / 100n)}.${(a % 100n).toString().padStart(2, "0")}`; };

async function shot(page: Page, name: string) {
  const dir = process.env.BROWSER_SHOTS;
  if (!dir) return;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const r = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(r.data, "base64"));
}

let server: ChildProcess | null = null;
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), LLM_PROVIDER: "mock", LLM_MODE: "live", LLM_API_KEY: "", SHORTAGE_AUTO_PLAN: "on" } as NodeJS.ProcessEnv;
  delete env.LLM_RECORDINGS_DIR;
  server = spawn(process.execPath.includes("bun") ? "node" : process.execPath, [join("node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT)], { env, stdio: "pipe" });
  let out = "";
  server.stdout?.on("data", (d) => { out += d; });
  server.stderr?.on("data", (d) => { out += d; });
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

class Api {
  cookie = ""; csrf = "";
  async call(path: string, body?: unknown, o: { method?: string; csrf?: string | null; origin?: string | null; cookie?: boolean } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.origin !== null) headers.origin = o.origin ?? BASE;
    if (this.cookie && o.cookie !== false) headers.cookie = this.cookie;
    const token = o.csrf === undefined ? this.csrf : o.csrf;
    if (token) headers["x-csrf-token"] = token;
    const res = await fetch(`${BASE}${path}`, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set?.startsWith("sme_session=")) this.cookie = set.split(";")[0];
    return { status: res.status, json: ((await res.json().catch(() => null)) ?? {}) as any };
  }
  async login(who: { email: string; password: string }) {
    const r = await this.call("/api/auth/login", who);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    this.csrf = r.json.csrfToken;
  }
  async enter(biz: string) { assert.equal((await this.call("/api/auth/business", { businessId: biz })).status, 200); }
}

async function uiLogin(page: Page, who: { email: string; password: string }, biz: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(`${BASE}/login`);
      await page.waitFor(`(()=>{const e=document.querySelector('input[type=email]');return e&&e.getClientRects().length>0})()`, "the sign-in form", 20_000);
      for (let i = 0; ; i++) {
        await page.type("input[type=email]", who.email);
        await page.type("input[type=password]", who.password);
        await page.sleep(500);
        if (await page.eval<boolean>(`document.querySelector('input[type=email]').value === ${JSON.stringify(who.email)} && document.querySelector('input[type=password]').value === ${JSON.stringify(who.password)}`)) break;
        assert.ok(i < 6, "the sign-in form kept the typed values");
      }
      await page.waitFor(`[...document.querySelectorAll('button')].some(b=>/^Sign in/.test(b.innerText)&&!b.disabled&&b.getClientRects().length>0)`, "the Sign in button", 20_000);
      await page.click("Sign in", 0, "button");
      await page.waitFor(`location.pathname.startsWith('/room')`, "the app after sign-in", 30_000);
      break;
    } catch (e) { if (attempt >= 2) throw e; }
  }
  const st = await page.eval<number>(`(async()=>{const s=await (await fetch('/api/auth/session')).json();return (await fetch('/api/auth/business',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':s.csrfToken},body:JSON.stringify({businessId:${JSON.stringify(biz)}})})).status})()`);
  assert.equal(st, 200, "the browser session works in this company");
}

/** Sets the value of the nth visible input/select (by its label text) the way a user would. */
const setField = (page: Page, label: string, value: string, nth = 0) => page.eval<boolean>(`(()=>{const ls=[...document.querySelectorAll('label')].filter(l=>(l.querySelector('span')?.innerText||'').trim().startsWith(${JSON.stringify(label)}));const l=ls[${nth}];if(!l)return false;const e=l.querySelector('input,select');const proto=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`);

async function main() {
  const owner = new Api();
  console.log("Setting up: dedicated demo company (healthy today) and a company that is really short");
  const flight = await createFlightDemo({ keepDbOpen: true });
  assert.ok(flight.lowestMinor >= flight.reserveMinor, "the demo company's books are healthy today");
  log(`demo company "${flight.name}": cushion ${gbp(flight.reserveMinor.toString())}, lowest balance today ${gbp(flight.lowestMinor.toString())}`);

  const useRunning = process.env.SIM_USE_RUNNING === "1";
  if (!useRunning) await startServer();
  try {
    // ------------------------------------------------------------ 1. route protection
    console.log("1. Route protection");
    const path = `/api/business/${flight.id}/simulate`;
    const scenario = { scenario: { shocks: [{ kind: "unexpected_expense", amount: "100.00", dueOn: "2099-01-01", label: "x" }] } };
    const anon = new Api();
    assert.equal((await anon.call(path)).status, 401, "GET without a session is refused");
    assert.equal((await anon.call(path, scenario)).status, 401, "POST without a session is refused");
    assert.equal((await anon.call(path, scenario, { cookie: false, csrf: "made-up" })).status, 401, "a made-up token without a session is refused");
    const page0 = await fetch(`${BASE}/room/simulator`, { redirect: "manual" });
    assert.ok([302, 303, 307, 308].includes(page0.status) && /\/login/.test(page0.headers.get("location") ?? ""), "the page redirects to sign-in");
    await owner.login(OWNER);
    await owner.enter(flight.id);
    assert.equal((await owner.call(path)).status, 200, "GET with a session works");
    assert.equal((await owner.call(path, scenario, { csrf: null })).status, 403, "POST without the CSRF token is refused");
    assert.equal((await owner.call(path, scenario, { csrf: "wrong-token" })).status, 403, "POST with a wrong CSRF token is refused");
    assert.equal((await owner.call(path, scenario, { origin: "http://evil.example" })).status, 403, "a cross-origin POST is refused");
    const other = await owner.call("/api/auth/session");
    assert.equal(other.status, 200);
    assert.equal((await owner.call(`/api/business/00000000-0000-4000-8000-000000000000/simulate`, scenario)).status, 403, "another company's simulator is refused");
    assert.equal((await owner.call(path, { scenario: { shocks: [] } })).status, 400, "an empty scenario is refused");
    assert.equal((await owner.call(path, { scenario: { shocks: [{ kind: "customer_late", counterpartyId: "not-an-id", days: 5 }] } })).status, 400, "a bad customer id is refused");
    assert.equal((await owner.call(path, { scenario: { shocks: [{ kind: "customer_late", counterpartyId: "00000000-0000-4000-8000-000000000001", days: 5 }] } })).status, 400, "an unknown customer is refused");
    const ok = await owner.call(path, scenario);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.report.hypothetical, true);
    assert.equal(ok.json.report.verified, false);
    const hp = `/api/business/${flight.id}/simulate/handoff`;
    const hbody = { simulationId: "00000000-0000-4000-8000-000000000000", scenario: scenario.scenario, strategyId: "0123456789abcdef" };
    assert.equal((await anon.call(hp, hbody)).status, 401, "handoff without a session is refused");
    assert.equal((await owner.call(hp, hbody, { csrf: null })).status, 403, "handoff without CSRF is refused");
    assert.equal((await owner.call(hp, hbody, { origin: "http://evil.example" })).status, 403, "cross-origin handoff is refused");
    assert.equal((await owner.call(hp, { ...hbody, strategyId: "x" })).status, 400, "malformed strategy id is refused");
    assert.equal((await owner.call(hp, hbody)).status, 404, "an unknown simulation is refused");
    const appr = new Api();
    await appr.login(APPROVER);
    await appr.enter(flight.id);
    assert.equal((await appr.call(hp, hbody)).status, 403, "an approver cannot add a strategy to Plans");
    log(`approver role may run the read-only simulation: ${(await appr.call(path, scenario)).status === 200 ? "yes" : "no"}`);
    log("anonymous GET/POST 401, page redirects; missing/wrong CSRF 403; cross-origin 403; other company 403; empty/bad/unknown bodies 400");

    // ------------------------------------------------------------ 2. the browser, in the demo company
    console.log("2. Browser journey in the demo company");
    const exe = findBrowser();
    if (!exe) { console.log("  NOT RUN: no Chromium-based browser found (set BROWSER_PATH). This is not a pass."); return; }
    const browser = await Browser.launch();
    if (!browser) { console.log("  NOT RUN: browser could not start."); return; }
    try {
      const page = await browser.newPage();
      await page.viewport(1280, 900);
      await uiLogin(page, OWNER, flight.id);
      await page.goto(`${BASE}/room`);
      await page.waitFor(`[...document.querySelectorAll('nav a')].some(a=>a.innerText.trim()==='Simulator')`, "the Simulator entry in the navigation");
      await page.click("Simulator", 0, "nav a");
      await page.waitText("Try a crisis on a copy of your books");
      assert.ok((await page.text()).includes("Nothing here is real"), "the page opens with the 'nothing is real' statement");
      await shot(page, "sim-1-start");

      // The combined crisis preset: largest customer 21 days late + supplier refuses to defer.
      await page.click("Combined crisis", 0, "button");
      await page.waitText("Scenario name");
      const sel = await page.eval<any>(`(()=>{const sels=[...document.querySelectorAll('select')];return {texts:sels.map(s=>s.options[s.selectedIndex]?.text),days:document.querySelector('input[inputmode=numeric]')?.value}})()`);
      assert.ok(sel.texts.some((t: string) => /Northgate.*\(largest\)/.test(t)), `the largest customer is preselected: ${JSON.stringify(sel.texts)}`);
      assert.ok(sel.texts.some((t: string) => /Kestrel/.test(t)) && sel.texts.some((t: string) => /deferral/.test(t)), "the supplier and the refusal are shown");
      assert.equal(sel.days, "21");
      await page.click("Run the simulation", 0, "button");
      await page.waitText("HYPOTHETICAL RESULT", 90_000);
      await page.waitText("Recommended response");
      await shot(page, "sim-2-combined");

      // The same scenario through the API (independent of the page) must give the figures the page shows.
      const shocksApi = (await owner.call(path)).json;
      const major = shocksApi.majorCustomerId as string;
      const sup = shocksApi.suppliers[0].id as string;
      const combined = { name: "Combined crisis", shocks: [{ kind: "customer_late", counterpartyId: major, days: 21 }, { kind: "supplier_refuses", counterpartyId: sup, lever: "supplier_defer_balance" }] };
      const api1 = (await owner.call(path, { scenario: combined })).json.report;
      const text1 = await page.text();
      for (const [what, v] of [["lowest today", api1.live.minBalanceMinor], ["lowest in scenario", api1.simulated.minBalanceMinor], ["shortfall", api1.simulated.gapMinor]] as const) assert.ok(text1.includes(gbp(v)), `the page shows the ${what} (${gbp(v)})`);
      assert.ok(BigInt(api1.simulated.gapMinor) > 0n, "the combined crisis creates a shortfall that today's books do not have");
      assert.ok(BigInt(api1.live.minBalanceMinor) >= BigInt(api1.reserveMinor), "today's books keep the cushion");
      const ev1 = api1.evaluation;
      const rec1 = ev1.candidates.find((c: any) => c.id === ev1.recommendedId);
      assert.ok(rec1 && rec1.outcome === "resolves", "the demo has a recommended response that resolves the shortage");
      for (const c of ev1.candidates) assert.ok(text1.includes(c.title), `the comparison lists "${c.title}"`);
      assert.ok(rec1.leverText.every((t: string) => text1.includes(t)), "the recommendation names its actions");
      const refused = ev1.candidates.filter((c: any) => c.levers.some((l: any) => l.kind === "supplier_defer_balance"));
      assert.ok(refused.every((c: any) => c.outcome === "blocked"), "anything that needs the refused deferral is shown as not available");
      assert.ok(text1.includes("Today's recommended plan") || ev1.candidates.every((c: any) => c.role !== "todays_plan"), "today's plan appears when there is one");
      // Hypothetical, never verified or approved
      for (const must of ["HYPOTHETICAL RESULT", "not verified", "unknown until they are asked", "Recommended", "(hypothetical)", "This is a simulation"]) assert.ok(text1.includes(must), `the page says "${must}"`);
      for (const mustNot of ["independently verified", "Approved", "approved by", "has been sent", "Executed", "Committed", "Verified"]) assert.ok(!text1.includes(mustNot), `the page never says "${mustNot}"`);
      assert.ok(await page.eval<boolean>(`!![...document.querySelectorAll('a')].find(a=>a.innerText.trim()==='Plans'&&a.closest('section'))`), "the way on to action is a link to Plans, not a button that acts");
      assert.equal(await page.eval<number>(`[...document.querySelectorAll('button')].filter(b=>/sign|approve|execute|send|apply now|run plan/i.test(b.innerText)&&!/sign out/i.test(b.innerText)).length`), 0, "the page has no sign, approve, execute or send button");
      log(`combined crisis: lowest ${gbp(api1.live.minBalanceMinor)} today → ${gbp(api1.simulated.minBalanceMinor)} in the scenario (${gbp(api1.simulated.gapMinor)} short); ${ev1.candidates.length} strategies compared; recommended: ${rec1.leverText.join("; ")}`);

      // Handoff: review the recommended strategy in Plans. Pre-emptive (today's books are healthy), so the owner must acknowledge before it is added.
      const q0 = postgres(process.env.DATABASE_URL!, { max: 1 });
      const authCount = async () => Number((await q0`select (select count(*) from plan_authorisations where business_id = ${flight.id}) + (select count(*) from plan_executions where business_id = ${flight.id}) + (select count(*) from sandbox_threads where business_id = ${flight.id}) + (select count(*) from sandbox_applications where business_id = ${flight.id}) as n`)[0].n);
      const plansCount = async () => Number((await q0`select count(*)::int as n from plans where business_id = ${flight.id}`)[0].n);
      assert.equal(await authCount(), 0);
      assert.equal(await plansCount(), 0);
      await page.click("Review this strategy in Plans", 0, "button");
      await page.waitFor(`/recalculated on your real books today/i.test(document.body.innerText)`, "the real-books recalculation", 60_000);
      const hText = await page.text();
      assert.ok(/pre-emptive/.test(hText) && /Nothing is signed, sent or scheduled by this step/.test(hText), "the handoff review says it is pre-emptive and that nothing is signed");
      assert.equal(await plansCount(), 0, "reviewing adds nothing");
      assert.ok(await page.eval<boolean>(`[...document.querySelectorAll('button')].find(b=>b.innerText.startsWith('Add to Plans as an unsigned proposal')).disabled`), "the add button stays disabled until the owner acknowledges");
      await shot(page, "sim-2b-handoff-review");
      await page.eval(`document.querySelector('input[type=checkbox]').click()`);
      await page.click("Add to Plans as an unsigned proposal", 0, "button");
      await page.waitText("Added to Plans as an unsigned proposal", 60_000);
      assert.equal(await plansCount(), 1, "exactly one plan was added");
      assert.equal(await authCount(), 0, "no authorisation, execution, thread or application exists after the handoff");
      await page.click("Open it in Plans", 0, "a");
      await page.waitFor(`location.pathname === '/room/case'`, "Plans");
      await page.waitText("Review and sign", 60_000);
      const finH = (rec1.levers.find((l: any) => l.kind === "finance_invoice") ?? {}).advanceBps;
      await page.waitText(`: ${finH / 100}% advance`, 30_000);
      const planText = await page.text();
      await page.waitFor(`/from your .Combined crisis. simulation [(]hypothetical[)]/i.test(document.body.innerText)`, "the plan says it came from the simulation", 30_000);
      assert.ok(!/It worked, and an independent check confirms it|Committed|Verified/.test(planText), "Plans does not say anything has run or been verified");
      await shot(page, "sim-2c-plans");
      // Starting the existing approval process: the signing dialog opens on the proposed schedule; we stop there.
      await page.click("Review and sign", 0, "button");
      await page.waitFor(`document.querySelector('dialog[open]')`, "the signing dialog");
      await page.waitText("Money it would schedule");
      assert.ok((await page.eval<string>(`document.querySelector('dialog[open]').innerText`)).includes("proposed, not agreed"), "the signing review says the schedule is proposed, not agreed");
      await shot(page, "sim-2d-signing-review");
      assert.equal(await authCount(), 0, "opening the review created no authorisation");
      await q0.end();
      await page.goto(`${BASE}/room/simulator`);
      await page.waitText("Try a crisis on a copy of your books");
      await page.click("Combined crisis", 0, "button");
      await page.waitText("Scenario name");
      await page.click("Run the simulation", 0, "button");
      await page.waitText("HYPOTHETICAL RESULT", 90_000);

      // Change one assumption: 21 → 7 days late, run again; the comparison appears and the whole thing is recomputed.
      assert.ok(await setField(page, "Days late", "7"));
      await page.click("Run again with these assumptions", 0, "button");
      await page.waitText("What changed from", 90_000);
      await page.waitFor(`document.body.innerText.includes('Major customer') || true`, "settle");
      const text2 = await page.text();
      const api2 = (await owner.call(path, { scenario: { name: "x", shocks: [{ ...combined.shocks[0], days: 7 }, combined.shocks[1]] } })).json.report;
      assert.ok(text2.includes(gbp(api2.simulated.minBalanceMinor)), "the page shows the new lowest balance");
      assert.ok(BigInt(api2.simulated.minBalanceMinor) > BigInt(api1.simulated.minBalanceMinor), "a shorter delay is better");
      assert.ok(/recomputed from scratch|lowest balance goes from/.test(text2), "the comparison says what moved");
      assert.ok(text2.includes("HYPOTHETICAL RESULT"), "the new result is still labelled hypothetical");
      await shot(page, "sim-3-changed");
      log(`changed 21→7 days: lowest ${gbp(api1.simulated.minBalanceMinor)} → ${gbp(api2.simulated.minBalanceMinor)}; verdict ${api2.evaluation.verdict}; page shows a comparison`);

      // A recoverable error: an expense with no amount.
      await page.click("Unexpected bill", 0, "button");
      await page.waitText("Scenario name");
      assert.ok(await setField(page, "Amount", ""));
      await page.click("Run again with these assumptions", 0, "button");
      await page.waitFor(`document.querySelector('[role=alert]')`, "an error for the missing amount", 30_000);
      const alertText = await page.eval<string>(`document.querySelector('[role=alert]').innerText`);
      assert.ok(/amount/i.test(alertText), `a missing amount is explained: ${alertText}`);
      log(`input error is explained in an alert: "${alertText}"`);
      const errs = page.consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e));
      if (errs.length) console.log("  CONSOLE ERRORS:", errs);
      assert.deepEqual(errs, [], "the simulator page logs no console errors");
    } finally {
      browser.close();
    }

    // ------------------------------------------------------------ 3. transition to action, in a company that really is short
    console.log("3. Transition to Plans (company that is really short)");
    // A company that REALLY is short, with a planning run, built in-process with the mock model (no model call goes through the server).
    const short = await createFlightDemo({ healthy: false, keepDbOpen: true });
    const biz = short.id;
    const { db: appDb } = await import("../src/db");
    const { startRun } = await import("../src/actions/agent-run");
    const { createGateway, RECORDINGS_DIR } = await import("../src/ai");
    const gw = createGateway({ provider: "mock", mode: "live", baseUrl: null, apiKey: null, model: "mock", supportsStructuredOutputs: false, recordingsDir: RECORDINGS_DIR });
    const planning = await startRun(appDb as any, biz, { type: "shortage", variant: "baseline" }, { gateway: gw, forceFallback: true });
    const runId = planning.runId;
    await owner.enter(biz);
    const sp = `/api/business/${biz}/simulate`;
    const asOf = (await owner.call(sp)).json.asOf as string;
    const far = new Date(Date.parse(`${asOf}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
    // A scenario whose only event falls beyond the forecast: the simulated world equals the real one.
    const noop = { name: "No change", shocks: [{ kind: "unexpected_expense", amount: "1.00", dueOn: far, label: "far away" }] };
    const sameRes = (await owner.call(sp, { scenario: noop })).json.report;
    assert.equal(sameRes.simulated.minBalanceMinor, sameRes.live.minBalanceMinor, "an event beyond the horizon changes nothing");
    const evS = sameRes.evaluation;
    const recS = evS.candidates.find((c: any) => c.id === evS.recommendedId);
    assert.ok(recS && recS.role === "coordinated", "the real shortage has the coordinated strategy as its recommendation");
    const plansBefore = ((await owner.call(`/api/business/${biz}/cases/${runId}`)).json.runs[0].plans as any[]).map((p) => p.id);
    log(plansBefore.includes(recS.id) ? "Plans already lists the exact recommended plan" : `Plans lists ${plansBefore.length} options and NOT the exact recommended plan ${recS.id}: this is the gap the handoff closes`);
    const q = postgres(process.env.DATABASE_URL!, { max: 1 });
    const counts = async () => Object.fromEntries(await Promise.all(["plan_authorisations", "plan_executions", "sandbox_threads", "sandbox_applications", "sandbox_payments", "sandbox_receipts"].map(async (t) => [t, Number((await q`select count(*)::int as n from ${q(t)} where business_id = ${biz}`)[0].n)])));
    const before = await counts();
    const hbase = { simulationId: sameRes.simulationId, scenario: noop, strategyId: recS.id };
    const hr = (await owner.call(`/api/business/${biz}/simulate/handoff`, { ...hbase, commit: true })).json;
    assert.ok(hr.ok && hr.committed && hr.runId === runId, `the strategy joins the open case: ${JSON.stringify(hr).slice(0, 200)}`);
    const plansAfter = (await owner.call(`/api/business/${biz}/cases/${runId}`)).json.runs[0].plans as any[];
    const stored = plansAfter.find((p) => p.id === recS.id)?.plan;
    assert.ok(stored, "the exact plan is in the case");
    if (plansBefore.includes(recS.id)) assert.equal(hr.unchanged, true, "a plan Plans already had is not added twice");
    else assert.ok(stored.source === "owner" && stored.fromSimulation, "an added plan is marked as coming from the simulation");
    assert.equal(stored.metrics.minBalanceMinor, recS.minBalanceMinor, "in an unchanged world Plans' figures equal the simulation's");
    assert.equal(plansAfter.length, plansBefore.length + (plansBefore.includes(recS.id) ? 0 : 1), "one plan was added (none if it was already there)");
    log(`simulated plan ${recS.id} entered Plans through the handoff with identical figures; it is unsigned`);
    assert.deepEqual(await counts(), before, "the handoff created no authorisation, execution, thread, application, payment or receipt");
    await owner.call(sp, { scenario: { name: "Late", shocks: [{ kind: "customer_late", counterpartyId: (await owner.call(sp)).json.majorCustomerId, days: 21 }] } });
    assert.deepEqual(await counts(), before, "simulating created nothing either");
    // Acting still needs the owner's own step-up: signing the plan with a wrong password creates nothing.
    const body = { runId, planId: recS.id, confirmations: 2 };
    const prev = await owner.call(`/api/business/${biz}/plan-authorisations/preview`, body);
    assert.equal(prev.status, 200, JSON.stringify(prev.json));
    const noPw = await owner.call(`/api/business/${biz}/plan-authorisations`, { ...body, letters: prev.json.letters, password: "wrong-password" });
    assert.ok(noPw.status >= 400, `signing with a wrong password is refused (${noPw.status})`);
    assert.equal(Number((await q`select count(*)::int as n from plan_authorisations where business_id = ${biz}`)[0].n), 0, "no authorisation exists without the owner's signature");
    const asApprover = new Api();
    await asApprover.login(APPROVER);
    await asApprover.enter(biz);
    const byApprover = await asApprover.call(`/api/business/${biz}/plan-authorisations`, { ...body, letters: prev.json.letters, password: APPROVER.password });
    assert.ok(byApprover.status >= 400, `an approver cannot sign as the owner (${byApprover.status})`);
    assert.deepEqual(await counts(), before, "nothing was created by the refused attempts");
    await q.end();

    // The same thing in the browser: Plans shows the plan, with Review and sign (the existing workflow), nothing already signed.
    const browser2 = await Browser.launch();
    if (browser2) {
      try {
        const page = await browser2.newPage();
        await page.viewport(1280, 900);
        await uiLogin(page, OWNER, biz);
        await page.goto(`${BASE}/room/case`);
        await page.waitText("Review and sign", 90_000);
        const fin = recS.levers.find((l: any) => l.kind === "finance_invoice");
        const needle = fin ? `: ${fin.advanceBps / 100}% advance` : "Review and sign";
        await page.waitText(needle, 30_000);
        const t = await page.text();
        assert.ok(t.includes(needle) && t.includes("Review and sign"), "Plans shows the simulated terms with Review and sign");
        assert.ok(!/It worked, and an independent check confirms it/.test(t), "Plans does not say anything has run");
        await shot(page, "sim-4-plans");
        log("Plans shows the plan with 'Review and sign'; nothing is signed, run or verified");
      } finally { browser2.close(); }
    }
  } finally {
    if (!useRunning) stopServer();
    await (await import("../src/db")).sql.end().catch(() => undefined);
  }
}

main().then(() => { console.log("simulator browser/route checks finished"); process.exit(0); }).catch((e) => { console.error(e); stopServer(); process.exit(1); });
