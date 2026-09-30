/** Offline, explicit v1 → v2 ledger migration. Run only after stopping servers and backing up PostgreSQL. */
import { pathToFileURL } from "node:url";
import { PgDatabase } from "@kaguya/database";
import { migrateModelTaskProtocol } from "./model-task-migration.js";

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply")
    throw new Error(
      "Usage: KAGUYA_MIGRATION_DATABASE_URL=... node dist/model-task-migration-cli.js --apply",
    );
  const connectionString = process.env.KAGUYA_MIGRATION_DATABASE_URL?.trim();
  if (!connectionString)
    throw new Error("KAGUYA_MIGRATION_DATABASE_URL is required");
  const database = await PgDatabase.connect({ connectionString });
  try {
    const report = await migrateModelTaskProtocol(database);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Migration failed"}\n`,
    );
    process.exitCode = 1;
  });
