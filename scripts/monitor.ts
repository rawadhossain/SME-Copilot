// Run the alert monitor from cron or by hand: bun run monitor [businessId]  (no id: the demo business). Raises, updates and resolves alerts; changes nothing else.
import { db, sql } from "../src/db";
import { getDefaultBusinessId } from "../src/db/queries";
import { runMonitor } from "../src/actions/monitor";

async function main() {
  const id = process.argv[2] ?? (await getDefaultBusinessId());
  if (!id) throw new Error("No business; run bun run db:seed first");
  const r = await runMonitor(db, id, { reason: "cron" });
  console.log(`monitor: as of ${r.asOf}; raised ${r.counts.raised}, escalated ${r.counts.escalated}, updated ${r.counts.updated}, resolved ${r.counts.resolved}; open ${r.counts.open}, acknowledged ${r.counts.acknowledged}${r.recoveryCaseId ? `; recovery case ${r.recoveryCaseId}` : ""}`);
}
main().then(() => sql.end()).catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
