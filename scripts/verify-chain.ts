// Verifies the action_records hash chain for every business. Uses the owner connection.
import { createHash } from "node:crypto";
import postgres from "postgres";

const GENESIS = "0".repeat(64);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });
  let bad = 0;
  let total = 0;
  try {
    // Recompute each SHA-256 here, independent of the database's hash.
    const rows = await sql<{ business_id: string; chain_seq: string; prev_hash: string; hash: string; canonical: string }[]>`
      SELECT business_id, chain_seq, prev_hash, hash, action_record_canonical(r) AS canonical
      FROM action_records r ORDER BY business_id, chain_seq`;
    let biz = "";
    let expectSeq = 0n;
    let prev = GENESIS;
    for (const r of rows) {
      total++;
      if (r.business_id !== biz) {
        biz = r.business_id;
        expectSeq = 0n;
        prev = GENESIS;
      }
      expectSeq += 1n;
      const sha = createHash("sha256").update(r.canonical, "utf8").digest("hex");
      const problems: string[] = [];
      if (BigInt(r.chain_seq) !== expectSeq) problems.push(`sequence gap (expected ${expectSeq})`);
      if (r.prev_hash !== prev) problems.push("prev_hash does not match previous record");
      if (r.hash !== sha) problems.push("hash does not match record contents");
      if (problems.length) {
        bad++;
        console.error(`BROKEN business=${r.business_id} seq=${r.chain_seq}: ${problems.join("; ")}`);
      }
      prev = r.hash;
    }
  } finally {
    await sql.end();
  }
  if (bad) {
    console.error(`chain verification FAILED: ${bad} broken of ${total} records`);
    process.exit(1);
  }
  console.log(`chain verification ok: ${total} records`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
