import { config } from "./config.js";
import { ensureDbStateTable, hasDatabaseState } from "./stateDb.js";
import { isMainModule } from "./utils.js";

async function main(): Promise<void> {
  if (!hasDatabaseState()) {
    throw new Error("DATABASE_URL is not set. Set DATABASE_URL or SUPABASE_DIRECT_URL before running migrations.");
  }

  await ensureDbStateTable();
  console.log(`[MIGRATE] app_state table ensured for database host from DATABASE_URL (port=${config.port}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
