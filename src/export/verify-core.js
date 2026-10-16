// Offline re-verification of an evidence export, from the exported file ALONE (Batch 11). Plain JavaScript with no imports, so the same
// source runs in Node (scripts/verify-export.mjs) and inside the exported HTML page. It uses the Web Crypto API for SHA-256 and Ed25519.
// What it checks: the owner's signatures on every mandate version and plan authorisation, that the hashes bound by those signatures match
// the exported terms and plan, that every action in the case is covered by an authorisation, and the per-business hash chain of the log
// (record by record, including that each exported record equals the text that was hashed).
//
// It does NOT prove the exported data is complete or the newest: compare the head hash with one you kept earlier.

const LEVER_ORDER = ["supplier_reduce_deposit", "supplier_defer_balance", "buyer_request_deposit", "finance_invoice", "chase_overdue", "early_payment_discount"];

export function canonicalize(value) {
  const sort = (v) => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(subtle, text) {
  return hex(await subtle.digest("SHA-256", enc.encode(text)));
}

async function sha256OfDataUrl(subtle, dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl ?? "");
  return m ? hex(await subtle.digest("SHA-256", b64(m[1]))) : null;
}

// Plans stored levers sorted (kind order, then canonical text); the levers hash is over that sorted list.
const sortLevers = (levers) => [...levers].sort((a, b) => `${LEVER_ORDER.indexOf(a.kind)}:${canonicalize(a)}`.localeCompare(`${LEVER_ORDER.indexOf(b.kind)}:${canonicalize(b)}`));

async function verifySignature(subtle, publicKeyB64, text, signatureB64) {
  try {
    const key = await subtle.importKey("spki", b64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, b64(signatureB64), enc.encode(text));
  } catch {
    return false;
  }
}

const sameJson = (a, b) => canonicalize(a) === canonicalize(b);

export async function verifyBundle(bundle, subtle = globalThis.crypto.subtle) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  add("format", bundle?.format === "ledgerhand-evidence/1", `format ${bundle?.format}`);
  if (bundle?.format !== "ledgerhand-evidence/1") return checks;
  const pub = bundle.publicKey;
  add("public key present", typeof pub === "string" && pub.length > 20, "the owner public key is included (a public key is not a secret)");

  // 1. Mandate versions: signed by the owner key.
  const mandateByVersion = {};
  for (const m of bundle.mandates) {
    const ok = await verifySignature(subtle, pub, m.canonical, m.signature);
    add(`mandate v${m.version} signature`, ok, ok ? "the owner signature over the exact mandate text verifies" : "SIGNATURE DOES NOT VERIFY");
    mandateByVersion[m.version] = m;
  }

  // 2. Plan authorisations: signature, and the hashes it binds.
  for (const a of bundle.authorisations) {
    const label = `authorisation ${a.id.slice(0, 8)}`;
    if (!a.signature) { add(`${label} signature`, a.status !== "authorised" && a.status !== "used", `never signed (status ${a.status})`); continue; }
    const message = { purpose: "plan.authorisation.v1", authorisationId: a.id, businessId: a.businessId, runId: a.runId, planId: a.planId, leversHash: a.leversHash, termsHash: a.termsHash, expiresAt: a.expiresAt, mandateVersion: a.mandateVersion, mandateHash: a.mandateHash, ...(a.lettersHash ? { lettersHash: a.lettersHash } : {}), ...(a.signatureHash ? { signatureHash: a.signatureHash } : {}) };
    const sigOk = await verifySignature(subtle, pub, canonicalize(message), a.signature);
    add(`${label} signature`, sigOk, sigOk ? `signed by the owner key (approved by ${a.approvedBy})` : "SIGNATURE DOES NOT VERIFY");
    add(`${label} terms hash`, (await sha256Hex(subtle, canonicalize(a.terms))) === a.termsHash, "the exported requests and bounds are exactly what was signed");
    if (a.lettersHash || a.letters) add(`${label} proposal letters`, !!a.letters && !!a.lettersHash && (await sha256Hex(subtle, canonicalize(a.letters))) === a.lettersHash, "the exported letters are exactly the wording the owner approved and signed");
    if (a.signatureHash || a.signatureImage) add(`${label} drawn signature`, !!a.signatureImage && !!a.signatureHash && (await sha256OfDataUrl(subtle, a.signatureImage)) === a.signatureHash, "the exported signature drawing is exactly the image that was signed");
    const plan = bundle.runs.flatMap((r) => r.plans).find((p) => p.id === a.planId);
    add(`${label} plan hash`, !!plan && (await sha256Hex(subtle, canonicalize(sortLevers(plan.plan.levers)))) === a.leversHash, "the exported plan levers are exactly what was signed");
    const m = mandateByVersion[a.mandateVersion];
    add(`${label} mandate binding`, !!m && (await sha256Hex(subtle, canonicalize(m.canonical))) === a.mandateHash, `bound to mandate version ${a.mandateVersion}`);
  }

  // 3. Actions: every action of an authorisation is listed with its gate decision and was logged as proposed + decided.
  const log = bundle.log;
  const events = new Set(log.records.map((r) => `${r.event}:${r.proposalId ?? ""}`));
  for (const a of bundle.authorisations) {
    for (const act of a.actions) {
      const hasGate = events.has(`gate.decision:${act.id}`) && events.has(`action.proposed:${act.id}`);
      add(`action ${act.id.slice(0, 8)} logged`, hasGate, `${act.kind}: proposed and gate-decided in the log (gate: ${act.gateResult?.decision}, status ${act.status})`);
    }
  }

  // 4. The hash chain, record by record.
  let prev = "0".repeat(64);
  let broke = null;
  let n = 0;
  for (const r of log.records) {
    n++;
    const parsed = (() => { try { return JSON.parse(r.canonical); } catch { return null; } })();
    const fieldsMatch = parsed && parsed[0] === bundle.business.id && String(parsed[1]) === String(r.chainSeq) && parsed[2] === r.id && (parsed[3] ?? null) === (r.proposalId ?? null) && parsed[4] === r.event && parsed[5] === r.actor && sameJson(parsed[6], r.detail) && parsed[7] === r.verification && parsed[9] === r.prevHash;
    const hashOk = (await sha256Hex(subtle, r.canonical)) === r.hash;
    if (String(r.chainSeq) !== String(n) || r.prevHash !== prev || !hashOk || !fieldsMatch) { broke = r.chainSeq; break; }
    prev = r.hash;
  }
  add("log hash chain", broke === null, broke === null ? `${log.records.length} records: each links to the one before, each hash matches its text, each exported field equals the hashed text` : `BROKEN at record ${broke}`);
  add("log head", broke === null && (log.records.at(-1)?.hash ?? null) === (log.head?.hash ?? null), `head hash ${log.head?.hash?.slice(0, 16)}… (keep a copy to detect later removal of newer records)`);

  // 5. Signing is in the log.
  for (const a of bundle.authorisations.filter((x) => x.signature)) {
    add(`authorisation ${a.id.slice(0, 8)} in the log`, log.records.some((r) => r.event === "plan.authorised" && r.detail?.authorisationId === a.id), "a plan.authorised record exists for it");
  }
  return checks;
}
