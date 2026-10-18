// Shared setup for the attack lab: throwaway is_test clones of the demo business (mock provider, pinned date), the money-bearing state fingerprint,
// and the log marker. Nothing here is part of the product.
/* eslint-disable @typescript-eslint/no-explicit-any */
import postgres from "postgres";
import type { Observed } from "./types";

export interface Clone {
  id: string;
  asOf: string;
  payee: { kestrel: string; lender: string };
  cp: { kestrel: string; northgate: string; clearwater: string; quickbuy: string; harbourline: string; pennine: string };
}

export class Harness {
  owner!: ReturnType<typeof postgres>;
  db!: any;
  sql!: any;
  S!: any;
  demoId!: string;
  private labels = new Map<string, string>();
  /** Every clone this run created (the secrets scan reads only these). */
  cloneIds: string[] = [];
  /** A value computed once and shared by several attacks. */
  cache = new Map<string, unknown>();
  private n = 0;
  key = () => `attack-${++this.n}-${process.pid}-${Date.now().toString(36)}`;

  static async create(): Promise<Harness> {
    const h = new Harness();
    const dbm = await import("../../src/db");
    h.db = dbm.db;
    h.sql = dbm.sql;
    h.S = await import("../../src/db/schema");
    h.owner = postgres(process.env.DATABASE_URL!, { max: 1 }); // owner role: only to tamper with stored data, as an attacker with database access would
    const { getDefaultBusinessId } = await import("../../src/db/queries");
    h.demoId = (await getDefaultBusinessId())!;
    if (!h.demoId) throw new Error("run bun run db:seed first");
    return h;
  }
  async close() {
    await this.owner.end();
    await this.sql.end();
  }

  rows = async <T = Record<string, any>>(strings: TemplateStringsArray, ...v: unknown[]): Promise<T[]> => (await (this.owner as any)(strings, ...v)) as T[];

  /** Replaces ids and hashes with stable labels so the output is the same on every run. */
  stable(text: string): string {
    return text
      .replace(/[0-9a-f]{64}/g, "<hash>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
        if (!this.labels.has(id)) this.labels.set(id, `<id${this.labels.size + 1}>`);
        return this.labels.get(id)!;
      });
  }

  async clone(label: string, opts: { bankMinor?: bigint } = {}): Promise<Clone> {
    const { createDemoClone } = await import("../../src/actions/demo-clone");
    const { id } = await createDemoClone(this.db, this.demoId);
    await this.owner`update businesses set name = ${`Attack Lab ${label} (SYNTHETIC)`} where id = ${id}`;
    if (opts.bankMinor !== undefined) {
      await this.owner`update financial_accounts set balance_minor = ${opts.bankMinor.toString()}::numeric where business_id = ${id}`;
      await this.owner`update sandbox_bank_accounts set balance_minor = ${opts.bankMinor.toString()}::numeric where business_id = ${id}`;
    }
    this.cloneIds.push(id);
    const cps = await this.rows<{ id: string; name: string }>`select id, name from counterparties where business_id = ${id}`;
    const cp = (frag: string) => cps.find((c) => c.name.includes(frag))!.id;
    const payees = await this.rows<{ id: string; name: string }>`select id, name from sandbox_payees where business_id = ${id}`;
    const payee = (frag: string) => payees.find((p) => p.name.includes(frag))!.id;
    const [w] = await this.rows<{ d: string }>`select max(balance_as_of)::date::text d from financial_accounts where business_id = ${id}`;
    return {
      id, asOf: w.d,
      payee: { kestrel: payee("Kestrel"), lender: payee("Clearwater") },
      cp: { kestrel: cp("Kestrel"), northgate: cp("Northgate"), clearwater: cp("Clearwater"), quickbuy: cp("Quickbuy"), harbourline: cp("Harbourline"), pennine: cp("Pennine") },
    };
  }

  /** What moves or commits money: the sandbox bank and its payments, receipts, agreements and applications. */
  async moneyState(id: string, core = false): Promise<string> {
    const [r] = await this.rows<{ h: string }>`select md5(concat_ws('|',
      (select coalesce(string_agg(balance_minor::text, ',' order by id), '') from sandbox_bank_accounts where business_id = ${id}),
      (select coalesce(md5(string_agg(x::text, ',' order by x::text)), '') from sandbox_payments x where business_id = ${id}),
      (select coalesce(md5(string_agg(x::text, ',' order by x::text)), '') from sandbox_receipts x where business_id = ${id}),
      (select case when ${core} then '' else coalesce(md5(string_agg(x::text, ',' order by x::text)), '') end from sandbox_threads x where business_id = ${id}),
      (select case when ${core} then '' else coalesce(md5(string_agg(x::text, ',' order by x::text)), '') end from sandbox_applications x where business_id = ${id}))) h`;
    return r.h;
  }
  async bankMinor(id: string): Promise<bigint> {
    const [r] = await this.rows<{ s: string }>`select coalesce(sum(balance_minor), 0)::text s from sandbox_bank_accounts where business_id = ${id}`;
    return BigInt(r.s);
  }
  /** Anything signed or executed: signed plan authorisations, plan executions, approved/executed proposals, executed payments. */
  async signedOrExecuted(id: string, core = false): Promise<string> {
    const [r] = await this.rows<{ s: string }>`select concat_ws('|',
      (select count(*) from plan_authorisations where business_id = ${id} and signature is not null),
      (select case when ${core} then 0 else count(*) end from plan_executions where business_id = ${id}),
      (select case when ${core} then 0 else count(*) end from action_proposals where business_id = ${id} and status in ('approved', 'executing', 'executed', 'verified')),
      (select count(*) from sandbox_payments where business_id = ${id} and status = 'executed')) s`;
    return r.s;
  }
  private async maxSeq(id: string): Promise<bigint> {
    const [r] = await this.rows<{ m: string }>`select coalesce(max(chain_seq), 0)::text m from action_records where business_id = ${id}`;
    return BigInt(r.m);
  }

  /** Runs one attempt and reports what changed: log events added, the money state, anything signed or executed. */
  async observe(clone: { id: string }, fn: () => Promise<{ kind: string; code: string; reason: string }>, opts: { core?: boolean } = {}): Promise<Observed> {
    const core = !!opts.core; // core: bank, payments and receipts only (the attempt may legitimately open a negotiation thread)
    const money0 = await this.moneyState(clone.id, core);
    const sig0 = await this.signedOrExecuted(clone.id, core);
    const seq0 = await this.maxSeq(clone.id);
    const r = await fn();
    const evs = await this.rows<{ event: string }>`select event from action_records where business_id = ${clone.id} and chain_seq > ${seq0.toString()}::bigint`;
    return {
      kind: r.kind, code: r.code, reason: this.stable(r.reason).slice(0, 300),
      events: [...new Set(evs.map((e) => e.event))].sort(),
      moneyUnchanged: (await this.moneyState(clone.id, core)) === money0,
      nothingSignedOrExecuted: (await this.signedOrExecuted(clone.id, core)) === sig0,
    };
  }
}
