// Seeds the SYNTHETIC demo accounts for the demo business (idempotent). Passwords are stored as scrypt hashes.
//   bun run auth:seed
// Demo credentials (synthetic, local only):
//   owner     owner@mercer-vale.example     Ledger-Owner-2026
//   approver  finance@mercer-vale.example   Ledger-Approver-2026   (the second confirmation for large payments)
import { hashPassword } from "../src/auth";

const ACCOUNTS = [
  { email: "owner@mercer-vale.example", displayName: "Alex Mercer (owner)", role: "owner", password: "Ledger-Owner-2026" },
  { email: "finance@mercer-vale.example", displayName: "Sam Vale (approver)", role: "approver", password: "Ledger-Approver-2026" },
] as const;

async function main() {
  const { db, sql } = await import("../src/db");
  const { ownerUsers } = await import("../src/db/schema");
  const { getDefaultBusinessId } = await import("../src/db/queries");
  const { eq } = await import("drizzle-orm");
  try {
    const businessId = await getDefaultBusinessId();
    if (!businessId) throw new Error("No demo business; run bun run db:seed first");
    for (const a of ACCOUNTS) {
      const [existing] = await db.select().from(ownerUsers).where(eq(ownerUsers.email, a.email));
      if (existing) { console.log(`exists: ${a.email}`); continue; }
      await db.insert(ownerUsers).values({ businessId, email: a.email, displayName: a.displayName, role: a.role, passwordHash: hashPassword(a.password) });
      console.log(`created: ${a.email} (${a.role})`);
    }
  } finally {
    await sql.end();
  }
}
await main();
