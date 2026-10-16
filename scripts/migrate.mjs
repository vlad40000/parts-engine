// Applies drizzle/ migrations to DATABASE_URL (Neon, or "pglite:<dir>" for local trials).
// All pending migrations and their history rows commit together or not at all.
//   --plan                       list pending migrations without writing anything
//   --expect <tag>=<sha256>[,…]  apply only if the pending list is exactly this, in order
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { applyMigrations, inspectMigrations, neonExecutor, parseExpectation, pgliteExecutor, readMigrations } from "./migration-runner.mjs";

let plan, expected;
try {
  const { values } = parseArgs({
    options: { plan: { type: "boolean", default: false }, expect: { type: "string" } },
    strict: true,
    allowPositionals: false
  });
  plan = values.plan;
  expected = values.expect === undefined ? undefined : parseExpectation(values.expect);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL first.");
  process.exit(1);
}
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const migrations = readMigrations(migrationsFolder);
const describe = (m) => `  ${m.tag}  sha256=${m.hash}  statements=${m.sql.length}  when=${m.folderMillis}`;

let db, close = async () => {};
if (url.startsWith("pglite:")) {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = new PGlite(url.slice("pglite:".length));
  db = pgliteExecutor(client);
  close = () => client.close();
} else {
  const { neon } = await import("@neondatabase/serverless");
  db = neonExecutor(neon(url));
}
try {
  if (plan) {
    const { latestCreatedAt, pending } = await inspectMigrations(db, migrations);
    const latest = migrations.find((m) => m.folderMillis === latestCreatedAt);
    console.log(`Latest recorded migration: ${latestCreatedAt === null ? "none" : `${latest?.tag ?? "unknown tag"} (created_at=${latestCreatedAt})`}`);
    console.log(pending.length ? `Pending migrations (${pending.length}):\n${pending.map(describe).join("\n")}` : "No pending migrations.");
  } else {
    const applied = await applyMigrations(db, migrations, { expect: expected });
    console.log(applied.length ? `Applied in one transaction (${applied.length}):\n${applied.map(describe).join("\n")}` : "No pending migrations.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await close();
}
