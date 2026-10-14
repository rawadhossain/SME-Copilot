import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL; // owner connection, used for migrations only
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "./src/db/migrations" });
    const pw = process.env.APP_DB_PASSWORD;
    if (!pw) throw new Error("APP_DB_PASSWORD is not set");
    await sql.unsafe(`ALTER ROLE sme_app WITH LOGIN PASSWORD '${pw.replaceAll("'", "''")}'`);
    console.log("migrations applied");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
