// PRIVILEGE. Who may sign, who may confirm, what a session may touch, and what the planner's code may import. The route handlers and the proxy are called
// in-process with real sessions (real login, real CSRF token), exactly as the server would call them. Sources: the e2e smoke's 401/403 cases, check:plan
// (two-person control), the ESLint layering rules in eslint.config.mjs.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { NextRequest } from "next/server";
import type { Attack, Observed } from "./types";
import { refusal, scenario } from "./plan-scenario";

const OWNER = { email: "owner@mercer-vale.example", password: "Ledger-Owner-2026" };
const APPROVER = { email: "finance@mercer-vale.example", password: "Ledger-Approver-2026" };
const ORIGIN = "http://localhost:3000";

/** A real signed-in session working in the given clone. */
async function sessionIn(h: any, who: { email: string; password: string }, cloneId: string) {
  const { login, getSession, switchBusiness } = await import("../../src/auth");
  const l = await login(h.db, who.email, who.password, "attack-lab");
  const s = (await getSession(h.db, l.token))!;
  await switchBusiness(h.db, s, cloneId);
  return { token: l.token, csrf: l.csrfToken, session: (await getSession(h.db, l.token))! };
}

const pure = (kind: string, code: string, reason: string): Observed => ({ kind, code, reason, events: [], moneyUnchanged: true, nothingSignedOrExecuted: true });

export const privilegeAttacks: Attack[] = [
  {
    id: "V01", category: "Privilege", moneyAttack: false,
    title: "An approver account tries to sign a plan as the owner",
    threat: "Someone with only second-approver rights signs the plan themselves.",
    setup: "Clone with a stored plan; a real approver session (their own password) working in the clone.",
    attack: "POST the plan-authorisations route as the approver, with the right CSRF token.",
    expected: { kind: "refused", code: "403", logged: false },
    run: async (h) => {
      const s = await scenario(h, "V01", { authorise: false });
      const a = await sessionIn(h, APPROVER, s.clone.id);
      const { POST } = await import("../../src/app/api/business/[id]/plan-authorisations/route");
      return h.observe(s.clone, async () => {
        const res = await POST(new Request(`${ORIGIN}/api/business/${s.clone.id}/plan-authorisations`, { method: "POST", headers: { "content-type": "application/json", cookie: `sme_session=${a.token}`, "x-csrf-token": a.csrf, origin: ORIGIN }, body: JSON.stringify({ runId: s.runId, planId: s.planHash, confirmations: 2, password: APPROVER.password }) }), { params: Promise.resolve({ id: s.clone.id }) } as any);
        const json: any = await res.json();
        return { kind: res.status === 403 ? "refused" : `status ${res.status}`, code: String(res.status), reason: String(json.error) };
      });
    },
  },
  {
    id: "V02", category: "Privilege", moneyAttack: false,
    title: "The same person gives both confirmations for a plan that needs two people",
    threat: "One person approves twice to get past two-person control.",
    setup: "A plan above the second-confirmation threshold waits for a second approver; the first confirmation came from the approver account.",
    attack: "confirmSecond as the same account.",
    expected: { kind: "refused", code: "refused", logged: true },
    run: async (h) => {
      const s = await scenario(h, "V02", { authorise: false });
      const a = await sessionIn(h, APPROVER, s.clone.id);
      const { requestSecondApproval, confirmSecond } = await import("../../src/actions/plan-authorise");
      const waiting: any = await requestSecondApproval(h.db, s.clone.id, { runId: s.runId, confirmations: 2, planId: s.planHash }, { id: a.session.user.id, name: a.session.user.displayName });
      if (waiting.status !== "awaiting_second") throw new Error(`setup: expected awaiting_second, got ${waiting.status}`);
      return h.observe(s.clone, () => refusal(() => confirmSecond(h.db, s.clone.id, waiting.authorisationId, { id: a.session.user.id, name: a.session.user.displayName, role: "approver" }, "approve")));
    },
  },
  {
    id: "V03", category: "Privilege", moneyAttack: false,
    title: "A wrong password at the signing step (step-up)",
    threat: "Someone at the owner's unlocked screen tries to sign without knowing the password.",
    setup: "A real owner session working in a clone.", attack: "verifyStepUp with a wrong password.",
    expected: { kind: "refused", code: "forbidden", logged: true },
    run: async (h) => {
      const s = await scenario(h, "V03", { authorise: false });
      const o = await sessionIn(h, OWNER, s.clone.id);
      const { verifyStepUp } = await import("../../src/auth");
      return h.observe(s.clone, () => refusal(() => verifyStepUp(h.db, o.session, "not-the-password", "sign plan authorisation")));
    },
  },
  {
    id: "V04", category: "Privilege", moneyAttack: false,
    title: "A request that changes something is sent without the CSRF token",
    threat: "A page on another site makes the owner's browser send a request using their cookie.",
    setup: "A real owner session; the request carries the cookie but no CSRF token.", attack: "POST /api/business/{id}/monitor/run through the access proxy.",
    expected: { kind: "refused", code: "403", logged: false },
    run: async (h) => {
      const c = await h.clone("V04");
      const o = await sessionIn(h, OWNER, c.id);
      const { proxy } = await import("../../src/proxy");
      return h.observe(c, async () => {
        const res = await proxy(new NextRequest(`${ORIGIN}/api/business/${c.id}/monitor/run`, { method: "POST", headers: { cookie: `sme_session=${o.token}`, origin: ORIGIN, host: "localhost:3000" } }));
        const json: any = await res.json().catch(() => ({}));
        return { kind: res.status === 403 ? "refused" : `status ${res.status}`, code: String(res.status), reason: String(json.error ?? "") };
      });
    },
  },
  {
    id: "V05", category: "Privilege", moneyAttack: false,
    title: "A session working in one business reads another business's data",
    threat: "Using one company's login to look into another company's books.",
    setup: "Two clones; a real owner session working in clone A.", attack: "GET /api/business/{B}/room through the access proxy.",
    expected: { kind: "refused", code: "403", logged: false },
    run: async (h) => {
      const a = await h.clone("V05-A");
      const b = await h.clone("V05-B");
      const o = await sessionIn(h, OWNER, a.id);
      const { proxy } = await import("../../src/proxy");
      return h.observe(b, async () => {
        const res = await proxy(new NextRequest(`${ORIGIN}/api/business/${b.id}/room`, { method: "GET", headers: { cookie: `sme_session=${o.token}`, host: "localhost:3000" } }));
        const json: any = await res.json().catch(() => ({}));
        return { kind: res.status === 403 ? "refused" : `status ${res.status}`, code: String(res.status), reason: String(json.error ?? "") };
      });
    },
  },
  {
    id: "V06", category: "Privilege", moneyAttack: false,
    title: "Code in the planner's folder (src/agent) imports the owner-signing code, the approval code and a sandbox money operation",
    threat: "A compromised planner module reaches the keys or the bank directly instead of going through the gate.",
    setup: "A temporary probe file is written under src/agent and ESLint is run on it; the probe is deleted afterwards (this attack announces it).",
    attack: "eslint src/agent/__attack_probe.ts with three forbidden imports and one allowed one.",
    expected: { kind: "blocked", code: "no-restricted-imports", logged: false },
    run: async () => {
      const probe = "src/agent/__attack_probe.ts";
      writeFileSync(probe, [
        `import { signMandate } from "../gate/owner-signing";`,
        `import { approveAction } from "../actions/approve";`,
        `import { schedulePayment } from "@/sandbox";`,
        `import { addDays } from "@/engine";`,
        `export const probe = [signMandate, approveAction, schedulePayment, addDays];`,
      ].join("\n") + "\n");
      try {
        const r = spawnSync(process.execPath.includes("bun") ? "bun" : "node", ["x", "eslint", "--format", "json", probe], { encoding: "utf8", shell: process.platform === "win32" });
        const parsed = JSON.parse(r.stdout || "[]")[0] ?? { messages: [] };
        const hits: any[] = parsed.messages.filter((m: any) => m.ruleId === "no-restricted-imports");
        const lines = hits.map((m) => m.line).sort();
        // import lines 1, 2 and 3 are forbidden; line 4 (a pure engine function) is allowed
        const ok = lines.includes(1) && lines.includes(2) && lines.includes(3) && !lines.includes(4);
        return pure(ok ? "blocked" : "not_blocked", "no-restricted-imports", `ESLint reported no-restricted-imports on probe lines ${lines.join(", ")} (the owner-signing import, the approval import and the sandbox write); the pure engine import was allowed`);
      } finally {
        if (existsSync(probe)) rmSync(probe);
      }
    },
  },
];
